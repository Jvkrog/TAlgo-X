// bootAnimation.js — animated "TALGO-X" reveal played once at toolbox
// startup, PLUS a static-banner renderer that toolbox.js's renderMenu()
// calls on every subsequent redraw, so the banner and the toolbox box below
// it are always drawn together as one unit — never one without the other.
// That's the actual fix for "banner disappears, then toolbox appears": the
// old version cleared the whole screen after the animation finished and
// handed off to a renderMenu() that knew nothing about the banner at all,
// so every redraw after boot showed the box alone, top-left, unrelated to
// what was just on screen a moment earlier.
//
// The banner text was generated with figlet's "ANSI Shadow" font as a
// one-time step and hardcoded here — not a runtime dependency.
"use strict";

const c = require("./c");

const BANNER = [
    "  ████████╗   █████╗ ██╗      ██████╗  ██████╗      ██╗  ██╗",
    "  ╚══██╔══╝  ██╔══██╗██║     ██╔════╝ ██╔═══██╗     ╚██╗██╔╝",
    "     ██║     ███████║██║     ██║  ███╗██║   ██║█████╗╚███╔╝ ",
    "     ██║     ██╔══██║██║     ██║   ██║██║   ██║╚════╝██╔██╗ ",
    "     ██║     ██║  ██║███████╗╚██████╔╝╚██████╔╝     ██╔╝ ██╗",
    "     ╚═╝     ╚═╝  ╚═╝╚══════╝ ╚═════╝  ╚═════╝      ╚═╝  ╚═╝",
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getTermSize() {
    return { cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 };
}

function scaleLine(line, factor) {
    if (factor === 1) return line;
    return [...line].map(ch => ch.repeat(factor)).join("");
}

// Doubles both dimensions — each source row becomes `factor` output rows,
// each character becomes `factor` repeats of itself horizontally.
function scaleBanner(lines, factor) {
    if (factor === 1) return lines;
    const out = [];
    for (const line of lines) {
        const wide = scaleLine(line, factor);
        for (let i = 0; i < factor; i++) out.push(wide);
    }
    return out;
}

// Only goes 2x when it'll comfortably fit without wrapping. Mobile SSH
// terminal apps are commonly 40-90 columns; a naive always-2x (114+ cols
// for this banner) would wrap on those and break centering entirely. Falls
// back to 1x, which is still bold and legible on its own — ANSI Shadow is
// a solid-block font, not thin line art.
function pickScale(cols, bannerWidth) {
    return cols >= (bannerWidth * 2 + 8) ? 2 : 1;
}

function centerLine(line, cols) {
    const pad = Math.max(0, Math.floor((cols - line.length) / 2));
    return " ".repeat(pad) + line;
}

function getScaledBanner() {
    const { cols } = getTermSize();
    const scale = pickScale(cols, BANNER[0].length);
    return { banner: scaleBanner(BANNER, scale), scale, cols };
}

// Draws the fully-revealed banner instantly (no animation), centered,
// with a blank-line margin above and below. Used by toolbox.js's
// renderMenu() on every redraw — same source art as the animated version,
// so the transition from the boot animation into normal use is visually
// seamless (same banner, same position, just re-drawn) — TALGO-X itself
// never visibly changes across that handoff, only the box below it does.
function renderStaticBanner({ topMargin = 2, bottomMargin = 1 } = {}) {
    const { banner, cols } = getScaledBanner();
    for (let i = 0; i < topMargin; i++) console.log();
    for (const line of banner) console.log(c.green(centerLine(line, cols)));
    for (let i = 0; i < bottomMargin; i++) console.log();
}

// Cosmetic staged-boot checklist — reflects what the toolbox process
// itself actually does at startup (loading its own config/strategy
// modules, connecting to PM2). Deliberately does NOT claim things like
// "Initializing SQLite" or "Connecting Broker" — those happen inside each
// per-instrument engine.js child process, not the toolbox itself, and
// listing them here would be describing something that isn't happening.
const BOOT_STAGES = [
    "Loading Configuration",
    "Loading Strategy Registry",
    "Connecting to PM2",
    "Checking Running Processes",
    "Toolbox Ready",
];

async function playBootAnimation({ pm2Connect } = {}) {
    const { banner, cols, rows } = { ...getScaledBanner(), rows: getTermSize().rows };
    const maxLineLen = Math.max(...banner.map(l => l.length));

    // Banner sits roughly an eighth of the way down — a real gap above it,
    // not flush against the top edge — leaving the rest of the screen for
    // the checklist and, immediately after, the toolbox box that follows.
    const topMargin = Math.max(1, Math.floor(rows * 0.12));
    const COLS_PER_FRAME = banner.length > BANNER.length ? 2 : 1; // faster reveal at 2x scale
    const FRAME_MS = 18;

    process.stdout.write("\x1b[2J\x1b[H\x1b[?25l"); // clear, cursor home, hide cursor

    try {
        for (let i = 0; i < topMargin; i++) process.stdout.write("\n");

        for (let col = 0; col <= maxLineLen; col += COLS_PER_FRAME) {
            process.stdout.write(`\x1b[${topMargin + 1};1H`);
            for (const line of banner) {
                process.stdout.write(c.green(centerLine(line.slice(0, col), cols)) + "\x1b[K\n");
            }
            await sleep(FRAME_MS);
        }

        await sleep(150);

        // Staged checklist, a couple of rows below the banner. TALGO-X
        // itself is never touched again past this point — only rows below
        // it get written to. Every stage except "Connecting to PM2" is
        // cosmetic pacing (short fixed delay), same convention as most CLI
        // boot sequences (docker, terraform, etc.) — but PM2 is a REAL
        // network call, and on a slow connection it can take a couple of
        // seconds. Showing nothing during that gap looks exactly like a
        // freeze (confirmed — that's what was happening on a slow mobile
        // connection), so that one stage shows a pending indicator, awaits
        // the actual connection, then confirms or reports failure —
        // genuine progress, not a cosmetic checkmark shown before the work
        // is done.
        console.log();
        for (const stage of BOOT_STAGES) {
            const plain = `✓ ${stage}`;
            const pad   = Math.max(0, Math.floor((cols - plain.length) / 2));

            if (stage === "Connecting to PM2" && pm2Connect) {
                const pendingText = `⏳ ${stage}...`;
                const pendingPad  = Math.max(0, Math.floor((cols - pendingText.length) / 2));
                process.stdout.write(" ".repeat(pendingPad) + c.dim(pendingText));
                try {
                    await pm2Connect();
                    process.stdout.write(`\r\x1b[2K${" ".repeat(pad)}${c.green("✓")} ${stage}`);
                } catch (err) {
                    process.stdout.write(`\r\x1b[2K${" ".repeat(pad)}${c.red(`✗ ${stage} failed — ${err.message}`)}`);
                    console.log();
                    console.log();
                    console.log(c.red("  Can't continue without PM2 — is it installed and running? (`pm2 list`)"));
                    process.stdout.write("\x1b[?25h");
                    process.exit(1);
                }
                console.log();
                await sleep(150);
                continue;
            }

            console.log(" ".repeat(pad) + `${c.green("✓")} ${stage}`);
            await sleep(150);
        }
    } finally {
        // No full clear here on purpose — main() calls renderMenu() next,
        // which redraws this exact same banner via renderStaticBanner()
        // immediately, so the handoff reads as continuous rather than a
        // blank gap between two unrelated screens.
        process.stdout.write("\x1b[?25h"); // just restore the cursor
    }
}

// Reveals a block of already-formatted lines one at a time, top to bottom,
// with a short delay between each — used for the toolbox box's first-ever
// appearance (right after the banner + checklist).
//
// This used to rise bottom-to-top via save/restore-cursor (\x1b[s/\x1b[u)
// and relative cursor-up jumps. That relies on the terminal actually
// supporting \x1b[s/\x1b[u, which turned out not to hold on at least one
// real mobile SSH terminal — the jumps landed on the wrong rows and
// shredded the banner above it (confirmed: banner reduced to a garbled
// sliver, box missing entirely). \x1b[s/\x1b[u are legacy SCO/ANSI.SYS
// sequences, not part of the standard terminal spec every emulator
// implements, unlike plain sequential printing. Trading the "rises from
// the bottom" effect for "reveals top to bottom" costs nothing important
// and needs no cursor positioning whatsoever — every line this prints is
// simply the next line of real stdout, exactly like the plain (non-
// animated) redraw path, just paced out with a delay. Guaranteed to work
// anywhere console.log does.
async function animateBoxUpward(lines, { delayMs = 26 } = {}) {
    for (const line of lines) {
        console.log(line);
        await sleep(delayMs);
    }
}

module.exports = { playBootAnimation, renderStaticBanner, animateBoxUpward };
