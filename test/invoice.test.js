var test = require('node:test');
var assert = require('node:assert/strict');
var pricing = require('../lib/pricing');
var invoice = require('../lib/invoice');
var reports = require('../lib/reports');

function orderFor(items, coupon) {
  var totals = pricing.computeTotals(items, coupon || '');
  return {
    id: 1, date: '01/04/2024', customer: 'Customer', status: 'completed',
    items: items, coupon: coupon || '', subtotal: totals.subtotal,
    discount: totals.discount, tax: totals.tax, total: totals.total
  };
}

test('invoice total and GST breakdown match the billed mixed-slab order', function () {
  var order = orderFor([
    { id: 1, name: 'Rice', hsn: '1006', price: 1000, qty: 1 },
    { id: 2, name: 'Ghee', hsn: '0405', price: 500, qty: 1 }
  ], 'SAVE10');
  var figures = invoice.computeInvoiceFigures(order);
  assert.deepEqual([figures.subtotal, figures.discount, figures.tax, figures.cgst, figures.sgst, figures.total],
    [1500, 150, 99, 49.5, 49.5, 1449]);
  assert.deepEqual(figures.rows.map(function (row) { return [row.gstPercent, row.lineTax]; }),
    [[5, 45], [12, 54]]);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});

test('invoice uses the billed HSN slabs and discounted tax for ordinary order lines', function () {
  var order = orderFor([
    { id: 1, name: 'Rice', hsn: '1006', price: 1000, qty: 1 },
    { id: 2, name: 'Ghee', hsn: '0405', price: 500, qty: 1 }
  ], 'SAVE10');
  var bill = pricing.computeTotals(order.items, order.coupon);
  var figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual([bill.subtotal, bill.discount, bill.tax, bill.cgst, bill.sgst, bill.total],
    [1500, 150, 99, 49.5, 49.5, 1449]);
  assert.deepEqual(bill.lines.map(function (line) { return [line.gstPercent, line.tax]; }),
    [[5, 45], [12, 54]]);
  assert.deepEqual([figures.subtotal, figures.discount, figures.tax, figures.cgst, figures.sgst, figures.total],
    [1500, 150, 99, 49.5, 49.5, 1449]);
  assert.deepEqual(figures.rows.map(function (row) { return [row.gstPercent, row.lineTax]; }),
    [[5, 45], [12, 54]]);
  var html = invoice.render(order);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
  assert.match(html, /1449\.00/);
});

test('invoice applies the billed percentage discount cap before tax', function () {
  var order = orderFor([{ id: 1, name: 'Rice', hsn: '1006', price: 2000, qty: 1 }], 'SAVE10');
  var figures = invoice.computeInvoiceFigures(order);
  assert.deepEqual([order.discount, order.tax, order.total], [150, 92.5, 1942.5]);
  assert.deepEqual([figures.discount, figures.tax, figures.total], [150, 92.5, 1942.5]);
});

test('invoice follows billing rules for flat and inactive coupons', function () {
  var items = [{ id: 1, name: 'Tea', hsn: '0902', price: 100, qty: 1 }];
  var flat = orderFor(items, 'FLAT50');
  var inactive = orderFor(items, 'DIWALI20');
  assert.deepEqual([flat.discount, flat.total], [0, 118]);
  assert.deepEqual([invoice.computeInvoiceFigures(flat).discount, invoice.computeInvoiceFigures(flat).total], [0, 118]);
  assert.deepEqual([inactive.discount, inactive.total], [0, 118]);
  assert.deepEqual([invoice.computeInvoiceFigures(inactive).discount, invoice.computeInvoiceFigures(inactive).total], [0, 118]);
});

test('invoice follows billing for fractional and zero explicit GST rates', function () {
  var fractional = orderFor([{ id: 1, name: 'Item', price: 1000, qty: 1, gstRate: 0.05 }]);
  var zero = orderFor([{ id: 2, name: 'Item', price: 1000, qty: 1, gstRate: 0 }]);
  assert.equal(fractional.tax, 50);
  assert.equal(invoice.computeInvoiceFigures(fractional).tax, 50);
  assert.equal(zero.tax, 0);
  assert.equal(invoice.computeInvoiceFigures(zero).tax, 0);
});

test('CURRENT BEHAVIOUR: matching figures have no reconciliation notice', function () {
  var order = orderFor([{ id: 1, name: 'Tea', hsn: '0902', price: 100, qty: 1 }]);
  var figures = invoice.computeInvoiceFigures(order);
  assert.deepEqual([figures.tax, figures.cgst, figures.sgst, figures.total], [18, 9, 9, 118]);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});

test('CURRENT BEHAVIOUR: reconciliation compares tax as well as total and skips cancelled orders', function () {
  var matched = orderFor([{ id: 1, name: 'Tea', hsn: '0902', price: 100, qty: 1 }]);
  var taxMismatch = Object.assign({}, matched, { id: 2, tax: 17 });
  var cancelled = Object.assign({}, matched, { id: 3, status: 'cancelled', total: 0 });
  var result = reports.getGstReconciliation({ orders: [matched, taxMismatch, cancelled] });
  assert.equal(result.totalChecked, 2);
  assert.equal(result.mismatchCount, 1);
  assert.equal(result.totalDelta, 0);
  assert.deepEqual(result.rows.map(function (row) { return [row.orderId, row.delta, row.matched]; }),
    [[1, 0, true], [2, 0, false]]);
  assert.doesNotMatch(invoice.render(taxMismatch), /Accountant Reconciliation Notice/);
});

test('historical stored totals that differ from current pricing still produce a warning', function () {
  var order = orderFor([{ id: 1, name: 'Rice', hsn: '1006', price: 100, qty: 1 }]);
  order.tax = 10;
  order.total = 110;
  var figures = invoice.computeInvoiceFigures(order);
  assert.equal(figures.total, 105);
  assert.match(invoice.render(order), /Accountant Reconciliation Notice/);
  assert.equal(reports.getGstReconciliation({ orders: [order] }).mismatchCount, 1);
});
