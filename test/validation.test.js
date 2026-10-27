'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const v = require('../utils/validation');
const { calculateTax } = require('../utils/money');
const { TRANSITIONS } = require('../services/orderService');

const rejects = (fn) => assert.throws(fn, (error) => error.statusCode === 400);

test('exactObject rejects non-objects and unknown fields (mass assignment)', () => {
    assert.deepEqual(v.exactObject({ a: 1 }, ['a', 'b']), { a: 1 });
    rejects(() => v.exactObject(null, ['a']));
    rejects(() => v.exactObject([], ['a']));
    rejects(() => v.exactObject('text', ['a']));
    rejects(() => v.exactObject({ a: 1, role: 'Admin' }, ['a']));
    rejects(() => v.exactObject(JSON.parse('{"__proto__": {"x": 1}, "a": 1}'), ['a']));
});

test('text trims, normalizes and bounds input', () => {
    assert.equal(v.text('  hello  ', 'f', { max: 10 }), 'hello');
    assert.equal(v.text('Café', 'f', { max: 10 }), 'Café');
    assert.equal(v.text('', 'f', { max: 10, allowEmpty: true }), '');
    rejects(() => v.text('', 'f', { max: 10 }));
    rejects(() => v.text('   ', 'f', { max: 10 }));
    rejects(() => v.text('x'.repeat(11), 'f', { max: 10 }));
    rejects(() => v.text(42, 'f', { max: 10 }));
    rejects(() => v.text(['a'], 'f', { max: 10 }));
    rejects(() => v.text('nul\u0000byte', 'f', { max: 20 }));
    rejects(() => v.text('ab', 'f', { min: 3, max: 10 }));
    assert.equal(v.text('line1\nline2', 'f', { max: 20 }), 'line1\nline2');
});

test('integer accepts only safe whole JSON numbers inside bounds', () => {
    assert.equal(v.integer(5, 'f', { min: 1, max: 10 }), 5);
    for (const bad of ['5', 5.5, NaN, Infinity, null, undefined, true, 0, 11, Number.MAX_SAFE_INTEGER + 1]) {
        rejects(() => v.integer(bad, 'f', { min: 1, max: 10 }));
    }
    rejects(() => v.integer(0, 'f', { min: -5, max: 5, nonZero: true }));
});

test('uuid and oneOf validate identifiers and enumerations', () => {
    const id = '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b';
    assert.equal(v.uuid(id.toUpperCase(), 'id'), id);
    for (const bad of ['', 'abc', "1' OR '1'='1", `${id}x`, null, 123, ['a']]) rejects(() => v.uuid(bad, 'id'));
    assert.equal(v.oneOf('a', 'f', ['a', 'b']), 'a');
    rejects(() => v.oneOf('c', 'f', ['a', 'b']));
    rejects(() => v.oneOf(['a'], 'f', ['a', 'b']));
});

test('pagination applies safe defaults and hard limits', () => {
    assert.deepEqual(v.pagination({}), { page: 1, limit: 20, offset: 0 });
    assert.deepEqual(v.pagination({ page: '3', limit: '10' }), { page: 3, limit: 10, offset: 20 });
    for (const bad of [{ page: '0' }, { page: '-1' }, { limit: '101' }, { limit: 'abc' }, { page: ['1', '2'] }, { limit: '1e3' }, { page: '9999999999' }]) {
        rejects(() => v.pagination(bad));
    }
    assert.equal(v.pagination({ limit: '200' }, { maxLimit: 200 }).limit, 200);
    assert.deepEqual(v.pageInfo({ page: 2, limit: 10 }, 25), { page: 2, limit: 10, total: 25, totalPages: 3 });
    assert.equal(v.pageInfo({ page: 1, limit: 10 }, 0).totalPages, 1);
});

test('optionalQueryText and escapeLike neutralize wildcards', () => {
    assert.equal(v.optionalQueryText(undefined, 'q'), undefined);
    assert.equal(v.optionalQueryText('', 'q'), undefined);
    assert.equal(v.optionalQueryText(' bolt ', 'q'), 'bolt');
    rejects(() => v.optionalQueryText(['a', 'b'], 'q'));
    rejects(() => v.optionalQueryText({ $ne: 1 }, 'q'));
    assert.equal(v.escapeLike('50%_off\\'), '50\\%\\_off\\\\');
});

test('tax is calculated in integer cents with half-up rounding', () => {
    assert.equal(calculateTax(5997, 1000), 600);
    assert.equal(calculateTax(1000, 0), 0);
    assert.equal(calculateTax(1, 1000), 0);
    assert.equal(calculateTax(5, 1000), 1);
    // Largest possible order: 50 lines x 10,000 units x 1,000,000.00 each. Subtotal x rate exceeds
    // Number.MAX_SAFE_INTEGER, so the calculation must be exact rather than floating point.
    const largestSubtotal = 100000000 * 10000 * 50;
    assert.ok(!Number.isSafeInteger(largestSubtotal * 2500));
    assert.equal(calculateTax(largestSubtotal, 2500), 12500000000000);
    assert.equal(calculateTax(largestSubtotal + 1, 10000), largestSubtotal + 1);
});

test('order workflow only moves forward and terminal states are final', () => {
    assert.deepEqual(Object.keys(TRANSITIONS).sort(), ['cancelled', 'confirmed', 'delivered', 'pending', 'shipped']);
    assert.deepEqual(TRANSITIONS.delivered, []);
    assert.deepEqual(TRANSITIONS.cancelled, []);
    assert.ok(!TRANSITIONS.shipped.includes('cancelled'), 'shipped goods cannot be cancelled');
    assert.ok(!TRANSITIONS.pending.includes('shipped'));
    for (const [from, targets] of Object.entries(TRANSITIONS)) {
        assert.ok(!targets.includes(from), `${from} must not transition to itself`);
    }
});
