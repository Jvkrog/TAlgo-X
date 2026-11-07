"use strict";
// conditionEvaluator.js — evaluates the AND/OR condition tree against a
// context built from indicatorEngine.js's output. Operand references are
// strings of the form "<indicatorId>.<field>" (e.g. "dpi_1.value",
// "alma_1.state"), or the literal strings "price.close"/"price.high"/
// "price.low", or a plain number for constants.

function resolveOperand(ref, ctx) {
    if (typeof ref === "number") return ref;
    if (ref === "price.close") return ctx.price.close;
    if (ref === "price.high")  return ctx.price.high;
    if (ref === "price.low")   return ctx.price.low;
    const [id, field] = ref.split(".");
    const val = ctx.indicatorValues.current[id];
    return val ? (val[field] ?? null) : null;
}

function resolvePrevOperand(ref, ctx) {
    if (typeof ref === "number") return ref;
    if (ref === "price.close") return ctx.prevPrice.close;
    if (ref === "price.high")  return ctx.prevPrice.high ?? null;
    if (ref === "price.low")   return ctx.prevPrice.low ?? null;
    const [id, field] = ref.split(".");
    const val = ctx.indicatorValues.previous[id];
    return val ? (val[field] ?? null) : null;
}

function evaluateLeaf(leaf, ctx) {
    const left  = resolveOperand(leaf.left, ctx);
    const right = resolveOperand(leaf.right, ctx);

    switch (leaf.operator) {
        case ">":  return left !== null && right !== null && left > right;
        case "<":  return left !== null && right !== null && left < right;
        case ">=": return left !== null && right !== null && left >= right;
        case "<=": return left !== null && right !== null && left <= right;
        case "==": return left !== null && right !== null && left === right;
        case "crosses_above": {
            const prevLeft = resolvePrevOperand(leaf.left, ctx);
            const prevRight = resolvePrevOperand(leaf.right, ctx);
            if ([left, right, prevLeft, prevRight].some(v => v === null)) return false;
            return prevLeft <= prevRight && left > right;
        }
        case "crosses_below": {
            const prevLeft = resolvePrevOperand(leaf.left, ctx);
            const prevRight = resolvePrevOperand(leaf.right, ctx);
            if ([left, right, prevLeft, prevRight].some(v => v === null)) return false;
            return prevLeft >= prevRight && left < right;
        }
        case "state_flips_to": {
            // leaf.right is a literal state label here, not an operand ref —
            // e.g. { left: "dpi_1.state", operator: "state_flips_to", right: "STRONG_BULL" }
            const prevVal = resolvePrevOperand(leaf.left, ctx);
            if (left === null) return false;
            return prevVal !== leaf.right && left === leaf.right;
        }
        default:
            throw new Error(`unknown operator: ${leaf.operator}`);
    }
}

// Tree node is either {op: "AND"|"OR", conditions: [...]} or a leaf
// {left, operator, right}. v1 trees are flat (single AND list for entry,
// single OR list for conditionExit) per the toolbox/webdash wizard's
// design, but this function itself supports real nesting if a spec is
// built some other way (e.g. hand-authored).
function evaluateTree(node, ctx) {
    if (!node) return false;
    if (node.op === "AND") return node.conditions.every(c => evaluateNode(c, ctx));
    if (node.op === "OR")  return node.conditions.some(c => evaluateNode(c, ctx));
    return evaluateLeaf(node, ctx);
}
function evaluateNode(node, ctx) {
    return node.op ? evaluateTree(node, ctx) : evaluateLeaf(node, ctx);
}

module.exports = { evaluateTree };
