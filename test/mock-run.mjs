// Runs run.mjs twice against a fake site to check diff output. Usage: node test/mock-run.mjs
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { execFileSync } from 'node:child_process';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-'));
const page = (name, sku, price, stock) => `<html><script type="application/ld+json">${JSON.stringify({'@type':'Product',name,sku,description:'Desc of '+name,image:['https://img/'+sku+'.jpg'],offers:{price,priceCurrency:'USD',availability:'https://schema.org/'+(stock?'InStock':'OutOfStock')}})}</script></html>`;
const preload = path.join(dir, 'mock.mjs');
const run = (state) => {
  fs.writeFileSync(path.join(dir,'state.json'), JSON.stringify(state));
  fs.writeFileSync(preload, `
    const s=JSON.parse(require('fs').readFileSync(${JSON.stringify(path.join(dir,'state.json'))},'utf8'));
    globalThis.fetch=async(u)=>{u=String(u);
      if(u.endsWith('/sitemap/en-us.xml')){const locs=Object.keys(s).map(k=>'<loc>https://www.mauijim.com/shop/accessories/'+k+'</loc>').join('');return new Response('<urlset>'+locs+'</urlset>');}
      const k=u.split('/').pop();const p=s[k];return p?new Response((${page.toString()})(p[0],p[1],p[2],p[3])):new Response('',{status:404});};`.replace('const s','const require=(await import("node:module")).createRequire(import.meta.url);const s'));
  // pad sitemap with dummy products so the 50-URL sanity check passes
  return execFileSync('node', ['--import', preload, 'src/run.mjs'], { env: { ...process.env, DATA_DIR: path.join(dir,'data'), DELAY_MS: '0' } }).toString();
};
const base = {}; for (let i = 0; i < 60; i++) base['item-'+i] = ['Item '+i, 'S'+i, 10+i, true];
run(base);
const second = { ...base, 'item-1': ['Item 1','S1',99,true], 'item-2': ['Item 2','S2',12,false], 'item-new': ['New thing','SNEW',5,true] }; delete second['item-3'];
console.log(run(second).trim().split('\n').pop());
console.log(fs.readFileSync(path.join(dir,'data','latest-changes.csv'),'utf8'));
console.log('changed rows:', fs.readFileSync(path.join(dir,'data','latest-changed-rows.csv'),'utf8').trim().split('\n').length-1);
console.log('feed rows:', fs.readFileSync(path.join(dir,'data','maui-jim-us-products.csv'),'utf8').trim().split('\n').length-1);
console.log('log rows:', fs.readFileSync(path.join(dir,'data','change-log.csv'),'utf8').trim().split('\n').length-1);
