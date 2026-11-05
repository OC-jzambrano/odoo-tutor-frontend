const {test,expect}=require('@playwright/test');
test('skip vertical alignment',async({page})=>{
await page.addInitScript(()=>{for(const db of ['odoo20_local','default_db'])for(const uid of [1,2])localStorage.setItem(`odoo_tutor.active_exercise_session:${db}:${uid}`,JSON.stringify({exerciseId:'alignment-check',startedAt:Date.now()}));});
await page.goto('/odoo/crm?debug=assets');
await page.locator('[data-ai-sidebar-toggle]').click();
await expect(page.locator('.ai-skip-step-button')).toBeVisible();
await page.waitForTimeout(600);
const boxes=await page.evaluate(()=>Object.fromEntries(['.ai-skip-step-button','.nlux-comp-composer > button','.nlux-comp-composer > textarea'].map(s=>{const r=document.querySelector(s).getBoundingClientRect();return [s,{x:r.x,y:r.y,width:r.width,height:r.height,centerY:r.y+r.height/2}]})));
console.log('ALIGNMENT',boxes);
await page.screenshot({path:'test-results/skip-alignment.png'});
expect(Math.abs(boxes['.ai-skip-step-button'].centerY-boxes['.nlux-comp-composer > button'].centerY)).toBeLessThanOrEqual(1);
});

