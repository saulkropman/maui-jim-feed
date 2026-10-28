// A product whose colours appear twice, including a bare extra entry with no details of its own.
// Each row's SKU, lens and variant code must belong together. Usage: node test/parse-dup-colour.mjs
import assert from 'node:assert/strict';
import { parseProduct } from '../src/parse.mjs';
const acc = (sku, lens) => [{ id: 'additional-information', richDescription: '<p>Desc</p>', factGroups: [{ items: [`SKU: ${sku}`, `Lens Color: ${lens}`, 'Lens Treatment: Polarized'] }] }];
const props = {
  title: 'HONI', productCode: 'R758-02', priceValue: 279, priceCurrency: 'USD', inStock: true,
  accordionItems: acc('R758-02/MJ0758S-026', 'Maui Rose'),
  frameColorSwatches: [{ id: 'Z0021::R758-02', label: 'Shiny Black' }, { id: 'Z0021::758-02', label: 'Shiny Black' }],
  frameColorMedia: { 'Z0021::R758-02': [{ src: 'https://img/r' }], 'Z0021::758-02': [{ src: 'https://img/n' }] },
  frameColorVariants: {
    'Z0021': { productCode: '758-02', priceValue: 279 }, // bare extra: no details of its own
    'Z0021::758-02': { productCode: '758-02', lensColorValue: 'Neutral Grey', priceValue: 279, accordionItems: acc('758-02/MJ0758S-004', 'Neutral Grey') },
    'Z0021::R758-02': { productCode: 'R758-02', lensColorValue: 'Maui Rose', priceValue: 279, accordionItems: acc('R758-02/MJ0758S-026', 'Maui Rose') },
  },
};
const flight = '0:' + JSON.stringify(['$', 'div', null, props]) + '\n';
const html = `<html><script>self.__next_f.push(${JSON.stringify([1, flight])})</script></html>`;
const { rows } = parseProduct(html, 'https://www.mauijim.com/shop/sunglasses/cateye/honi');
const by = Object.fromEntries(rows.map(r => [r.sku, r]));
assert.deepEqual(Object.keys(by).sort(), ['758-02', 'R758-02']);
assert.equal(by['758-02'].lens_colour, 'Neutral Grey');
assert.equal(by['758-02'].variant_code, '758-02');
assert.equal(by['758-02'].frame_colour_id, 'Z0021::758-02');
assert.equal(by['758-02'].manufacturer_product_number, 'MJ0758S-004');
assert.equal(by['R758-02'].lens_colour, 'Maui Rose');
assert.equal(by['R758-02'].variant_code, 'R758-02');
assert.equal(by['R758-02'].main_image_url, 'https://img/r');
console.log('parse-dup-colour: ok', rows.map(r => `${r.sku}/${r.variant_code}/${r.lens_colour}/${r.frame_colour_id}`).join('  '));
