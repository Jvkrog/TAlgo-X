// WebDash theme panel (Chromium): dark/light, RGB inputs, persistence, reset, no stray hardcoded palette colours left in style.css.
const assert = require("assert"), http = require("http"), fs = require("fs"), path = require("path");
const { chromium } = require("playwright");
const PUB = path.join(__dirname, "..", "webdash/public"), MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const srv = http.createServer((q, r) => { const f = path.join(PUB, q.url.split("?")[0] === "/" ? "index.html" : q.url.split("?")[0]); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(200, { "content-type": "application/json" }); return r.end("{}"); } r.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" }); r.end(fs.readFileSync(f)); });
const T = [], t = (n, f) => T.push([n, f]), SHOT = process.env.SHOTS;
(async () => {
  await new Promise(r => srv.listen(0, r)); const url = `http://127.0.0.1:${srv.address().port}/`;
  const br = await chromium.launch(), ctx = await br.newContext({ viewport: { width: 1280, height: 800 } }), page = await ctx.newPage();
  await page.route("**/fonts.g*/**", r => r.abort());
  const css = n => page.evaluate(n => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), n), bodyBg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.goto(url); await page.waitForSelector("#themeBtn", { state: "attached" });
  const open = async () => { await page.evaluate(() => document.getElementById("themeBtn").click()); await page.waitForSelector("#themeModal.open"); };
  t("default is the original terminal look (dark, green)", async () => { assert.strictEqual(await page.evaluate(() => document.documentElement.getAttribute("data-theme")), "dark"); assert.strictEqual((await css("--green")).toLowerCase(), "#33ff88"); assert.strictEqual(await bodyBg(), "rgb(5, 8, 6)"); });
  t("light mode flips background, text and overlays", async () => { await open(); await page.click('[data-mode="light"]'); assert.strictEqual(await bodyBg(), "rgb(242, 246, 243)"); assert.strictEqual(await css("--overlay-rgb"), "0, 0, 0"); assert.strictEqual(await css("--white"), "#10231a"); if (SHOT) await page.screenshot({ path: SHOT + "/light.png" }); });
  t("RGB inputs change the accent live and the derived rgb triplet follows", async () => {
    const n = c => page.locator(`.theme-row input[data-k="accent"][data-c="${c}"]`); await n(0).fill("200"); await n(1).fill("30"); await n(2).fill("90");
    assert.strictEqual((await css("--green")).toLowerCase(), "#c81e5a"); assert.strictEqual(await css("--accent-rgb"), "200, 30, 90");
    assert.strictEqual(await page.evaluate(() => getComputedStyle(document.querySelector(".theme-sample span")).color), "rgb(200, 30, 90)");
  });
  t("custom accent survives a dark/light toggle; bg/text follow the mode", async () => { await page.click('[data-mode="dark"]'); assert.strictEqual((await css("--green")).toLowerCase(), "#c81e5a"); assert.strictEqual(await bodyBg(), "rgb(5, 8, 6)"); });
  t("bad contrast warns", async () => { const n = c => page.locator(`.theme-row input[data-k="text"][data-c="${c}"]`); for (const c of [0, 1, 2]) await n(c).fill("8"); assert.ok(/hard to read/.test(await page.textContent("#themeWarn"))); });
  t("saved to localStorage and restored after reload (applied before first paint)", async () => { await page.reload(); await page.waitForSelector("#themeBtn", { state: "attached" }); assert.strictEqual((await css("--green")).toLowerCase(), "#c81e5a"); assert.strictEqual(await css("--white"), "#080808"); });
  t("reset returns to defaults and clears storage", async () => { await open(); await page.click("#themeReset"); assert.strictEqual((await css("--green")).toLowerCase(), "#33ff88"); assert.strictEqual(await page.evaluate(() => localStorage.getItem("talgox.theme.v1")), null); await page.click("#themeClose"); });
  t("presets recolour the accent", async () => { await open(); await page.click('.theme-swatch:has-text("Amber")'); assert.strictEqual((await css("--green")).toLowerCase(), "#ffb000"); await page.click("#themeReset"); });
  t("style.css has no bare palette colours left outside :root and var() fallbacks", () => {
    const s = fs.readFileSync(PUB + "/style.css", "utf8"), body = s.slice(s.indexOf("}\n") + 2);
    const bad = (body.match(/(?<![,\w#-])(?<!, )#(?:33ff88|ff5266|ffcc4d|050806|eafff2|6dffb0|4de3ff|ffb347)\b|rgba?\(\s*(?:51\s*,\s*255\s*,\s*136|70\s*,\s*255\s*,\s*150|255\s*,\s*82\s*,\s*102|77\s*,\s*227\s*,\s*255)/gi) || []);
    assert.deepStrictEqual(bad, []);
  });
  let fail = 0; for (const [n, f] of T) { try { await f(); console.log("  ok   " + n); } catch (e) { fail++; console.log("  FAIL " + n + "\n       " + String(e.message).split("\n").slice(0, 3).join("\n       ")); } }
  await br.close(); srv.close(); console.log(fail ? `\n${fail} FAILED` : `\nall ${T.length} passed`); process.exit(fail ? 1 : 0);
})();
