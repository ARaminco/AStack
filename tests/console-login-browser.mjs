import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';

// All credentials and responses here are fixtures; no user is created.
export async function verifyLogin(browser, base, token, {shots} = {}) {
  let checks = 0;
  const check = (value, message) => { assert.ok(value, message); checks++; };
  async function fixture({first = false, totp = 'off', lang, theme = 'light', viewport = {width:390,height:844}} = {}) {
    const context = await browser.newContext({locale:'en-US',viewport,serviceWorkers:'block',reducedMotion:'reduce'});
    const page = await context.newPage(), problems = [], posts = [];
    page.on('pageerror', e => problems.push(e.message));
    page.on('console', m => { if(m.type() === 'error' && !/Failed to load resource.*(?:401|429)/.test(m.text())) problems.push(m.text()); });
    await page.addInitScript(({lang,theme}) => {
      if(lang && !localStorage.getItem('aramis-lang')) localStorage.setItem('aramis-lang',lang);
      if(!localStorage.getItem('aramis-theme')) localStorage.setItem('aramis-theme',theme);
      window.__loginCsp = [];
      document.addEventListener('securitypolicyviolation',e => window.__loginCsp.push(e.violatedDirective));
    },{lang,theme});
    await page.route('**/api/session',route => route.fulfill({json:{authenticated:false,locale:'en',login:{methods:first?['token']:['password','token'],firstRun:first,totp,remote:false}}}));
    let response = 'failure';
    await page.route('**/api/login',async route => {
      posts.push(route.request().postDataJSON());
      if(response === 'loading') return;
      if(response === 'success') {
        await page.unroute('**/api/session');
        const result = await route.fetch({postData:JSON.stringify({token})});
        await route.fulfill({response:result});
      } else await route.fulfill({status:response==='locked'?429:401,headers:response==='locked'?{'retry-after':'2'}:{},json:{ok:false,error:'fixture failure',retryAfterSeconds:999}});
    });
    await page.goto(base+'/'); await page.waitForSelector('#credForm'); await page.evaluate(()=>document.fonts.ready);
    const close = context.close.bind(context);
    context.close = async () => {
      const violations = await page.evaluate(()=>window.__loginCsp);
      await close();
      check(problems.length === 0 && violations.length === 0, 'no login CSP or console errors: '+problems.concat(violations).join('; '));
    };
    const submit = async () => {await page.locator('#u').fill('operator۱۲'); await page.locator('#p').fill('fixture-password'); await page.locator('#go').click();};
    return {context,page,problems,posts,submit,setResponse:value=>response=value};
  }
  let f = await fixture();
  try {
    check(await f.page.locator('html').getAttribute('lang') === 'fa','Persian is default under English browser/server locale');
    check(await f.page.locator('#u').isVisible(),'password is the primary method');
    await f.page.locator('#langBtn').click(); await f.page.waitForSelector('html[lang=en]');
    check(await f.page.evaluate(()=>localStorage.getItem('aramis-lang')) === 'en','language toggle persists explicitly');
    await f.page.locator('#themeBtn').click();
    check(await f.page.evaluate(()=>localStorage.getItem('aramis-theme')) === 'dark','theme toggle persists');
    await f.page.reload(); await f.page.waitForSelector('#credForm');
    check(await f.page.locator('html').getAttribute('lang') === 'en' && await f.page.locator('html').getAttribute('data-theme') === 'dark','preferences survive reload');
    await f.page.locator('#langBtn').click(); await f.page.waitForSelector('html[lang=fa]');
    await f.submit(); await f.page.waitForSelector('html[data-state=error]');
    check(f.posts[0].username === 'operator12','username Persian digits normalize');
    check(await f.page.locator('#p').inputValue() === '', 'failed password is cleared');
    check(await f.page.locator('#p').evaluate(el=>el===document.activeElement),'failure focuses password');
    const uniform = await f.page.locator('#err').textContent();
    await f.page.locator('#altBtn').click();
    await f.page.waitForSelector('#t', {state:'visible',timeout:4000}); check(await f.page.locator('#t').isVisible(),'quiet token link switches form');
    await f.page.locator('#t').fill('fixture-token'); await f.page.locator('#go').click(); await f.page.waitForSelector('html[data-state=error]');
    check(await f.page.locator('#err').textContent() === uniform,'token and password share a uniform error');
    await f.page.locator('#altBtn').click(); f.setResponse('locked'); await f.submit(); await f.page.waitForSelector('html[data-state=locked]');
    check(await f.page.locator('#go').isDisabled() && await f.page.locator('#altBtn').isDisabled(),'lockout disables input and alternative');
    check((await f.page.locator('.clock').first().textContent()).includes('۰:۰۲'),'header retry-after wins over body');
    await f.page.waitForSelector('html[data-state=default]',{timeout:5000}); check(await f.page.locator('#go').isEnabled(),'countdown unlocks automatically');
    f.setResponse('success'); await f.submit(); await f.page.waitForSelector('html:not([data-login])'); check(true,'password success enters console');
  } finally {await f.context.close();}
  f = await fixture({totp:'required'});
  try {
    await f.submit(); await f.page.waitForSelector('html[data-state=totp]');
    check(f.posts.length===0,'TOTP step does not prematurely send credentials');
    await f.page.locator('#code').fill('١۲٣۴٥۶'); await f.page.waitForSelector('html[data-state=error]');
    check(f.posts.length===1 && f.posts[0].code==='123456' && f.posts[0].password==='fixture-password','TOTP autosubmits normalized ASCII with credentials exactly once');
    check(!(await f.page.locator('#p').inputValue()),'TOTP failure clears password');
  } finally {await f.context.close();}
  f = await fixture({first:true});
  try {
    check(await f.page.locator('.n-first').isVisible() && await f.page.locator('#altBtn').isHidden(),'first run displays token hint and hides alternative');
    check(await f.page.locator('#t').isVisible(),'first run uses token');
  } finally {await f.context.close();}
  if(shots) {
    await mkdir(shots,{recursive:true});
    for(const width of [390,1440]) for(const theme of ['light','dark']) for(const lang of ['fa','en']) for(const state of ['default','error','token','firstrun','totp','locked','loading']) {
      f = await fixture({first:state==='firstrun',totp:state==='totp'?'required':'off',lang,theme,viewport:{width,height:width===390?844:900}});
      try {
        if(state==='token') await f.page.locator('#altBtn').click();
        if(['error','totp','locked','loading'].includes(state)) {
          if(['locked','loading'].includes(state)) f.setResponse(state);
          await f.submit(); await f.page.waitForSelector('html[data-state='+state+']');
          if(state==='totp') await f.page.locator('#code').fill('482');
        }
        const geometry = await f.page.evaluate(()=>({width:document.documentElement.scrollWidth,view:innerWidth,inline:document.querySelectorAll('[style],[onclick],[onsubmit]').length}));
        check(geometry.width<=geometry.view && geometry.inline===0,'no horizontal overflow or inline styles/handlers');
        await f.page.screenshot({path:join(shots,`${state}-${width}-${theme}-${lang}.png`),fullPage:true});
        check(f.problems.length===0 && (await f.page.evaluate(()=>window.__loginCsp)).length===0,'login has no console/CSP errors: '+f.problems.join(';'));
      } finally {await f.context.close();}
    }
  }
  return checks;
}
