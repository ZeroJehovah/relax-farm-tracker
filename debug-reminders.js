// Temporary debug script to inspect reminder state
// Load this in the Chrome DevTools console on the background service worker page

async function debugReminders() {
  const data = await chrome.storage.local.get('farmState');
  const state = data.farmState || {};
  
  console.log('=== Farm State Debug ===');
  console.log('Current time:', new Date().toLocaleString());
  console.log('\nReminders:', state.reminders);
  
  if (state.reminders && state.reminders.length) {
    const now = Date.now();
    const activeCrops = (state.crops || []).filter(c => 
      !c.harvested && (c.maturesAt > now || now - c.maturesAt < 5*60*1000)
    );
    const nearest = activeCrops.length ? 
      activeCrops.reduce((m, c) => c.maturesAt < m ? c.maturesAt : m, activeCrops[0].maturesAt) : 
      null;
    
    console.log('\nNearest maturity:', nearest ? new Date(nearest).toLocaleString() : 'none');
    console.log('Active crops:', activeCrops.length);
    
    state.reminders.forEach((r, i) => {
      const target = nearest ? (r.mode === 'after' ? nearest + r.seconds * 1000 : nearest - r.seconds * 1000) : null;
      console.log(`\nReminder ${i}:`);
      console.log('  ID:', r.id);
      console.log('  Enabled:', r.enabled);
      console.log('  Mode:', r.mode, '/', r.seconds/60, 'min');
      console.log('  Target time:', target ? new Date(target).toLocaleString() : 'null');
      console.log('  Last fired:', r.lastFiredTarget ? new Date(r.lastFiredTarget).toLocaleString() : 'never');
      console.log('  Should fire now?', target && now >= target && r.lastFiredTarget !== target);
    });
  }
  
  // Check alarms
  const alarms = await chrome.alarms.getAll();
  console.log('\n=== Alarms ===');
  console.log('Registered alarms:', alarms);
}

debugReminders();
