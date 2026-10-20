async page => {
  await page.click('.mode-card[data-mode=solo]');
  await page.click('.car-card[data-car-id=mercedes-w15]');
  await page.waitForSelector('#trackModal.open', { timeout: 6000 });
  const chips = await page.locator('#lapChips .online-chip').allTextContents();
  await page.click('#lapChips [data-laps="8"]');
  const hint = await page.textContent('#lapsHint');
  const active = await page.textContent('#lapChips .online-chip.active');
  await page.click('.track-card[data-track-id=monza]');
  await page.waitForFunction(() => window.__gp && window.__gp.started, { timeout: 6000 });
  await page.waitForTimeout(500);
  const hud = await page.evaluate(() => {
    const lapEl = document.getElementById('lap') || document.getElementById('statusLap');
    return lapEl ? lapEl.textContent : null;
  });
  return JSON.stringify({ chips, hint, active, hudText: hud });
}
