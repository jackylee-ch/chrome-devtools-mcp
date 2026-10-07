import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ChildSupervisor, IdleTimer} from '../src/supervisor.mjs';

const FAKE = new URL('./fake-mcp-child.mjs', import.meta.url).pathname;

test('S7: child swap keeps connection, tools stable, in-flight request answered by NEW child', async () => {
  const sup = await new ChildSupervisor('node', [FAKE]).start();
  try {
    // handshake captured the (stable) tool list
    assert.deepEqual(sup.tools, ['navigate_page', 'take_snapshot', 'screenshot']);

    const before = await sup.request('ping', {});
    // start a swap and, WITHOUT awaiting it, fire a request — it must queue through the swap
    const swapP = sup.swap();
    const during = sup.request('ping', {});
    const [swapRes, duringRes] = await Promise.all([swapP, during]);

    assert.equal(swapRes.toolsStable, true, 'tool list unchanged across swap');
    assert.notEqual(swapRes.newPid, swapRes.oldPid, 'child actually swapped');
    assert.equal(before.pid, swapRes.oldPid, 'first ping hit the old child');
    assert.equal(duringRes.pid, swapRes.newPid, 'queued request answered by the NEW child');

    // connection still usable after swap
    const after = await sup.request('ping', {});
    assert.equal(after.pid, swapRes.newPid);
  } finally {
    sup.stop();
  }
});

test('IdleTimer fires onIdle after inactivity', async () => {
  const fired = await new Promise(resolve => {
    const it = new IdleTimer(40, () => resolve(true));
    it.touch();
    setTimeout(() => resolve(false), 500); // guard
  });
  assert.equal(fired, true);
});

test('IdleTimer resets on touch (does not fire early)', async () => {
  let fires = 0;
  const it = new IdleTimer(60, () => { fires++; });
  it.touch();
  await new Promise(r => setTimeout(r, 30));
  it.touch(); // reset before 60ms
  await new Promise(r => setTimeout(r, 30));
  assert.equal(fires, 0, 'should not have fired yet (was reset)');
  await new Promise(r => setTimeout(r, 80));
  assert.equal(fires, 1, 'fires once after final idle');
  it.stop();
});

test('S-notif: supervisor forwards server→client notifications upstream', async () => {
  const sup = await new ChildSupervisor('node', [FAKE]).start();
  const notes = [];
  sup.onNotification = m => notes.push(m);
  try {
    await sup.request('ping', {emitNote: true});
    await new Promise(r => setTimeout(r, 50));
    assert.equal(notes.length, 1, 'one notification forwarded');
    assert.equal(notes[0].method, 'notifications/message');
    assert.equal(notes[0].id, undefined, 'notification has no id');
  } finally {
    sup.stop();
  }
});
