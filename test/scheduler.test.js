import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStatusScheduler } from '../public/room-scheduler.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('room scheduler limits concurrency and checks every due room', async () => {
  const rooms = Array.from({ length: 8 }, (_, index) => ({ id: index, nextCheckAt: 0 }));
  let active = 0;
  let peak = 0;
  const checked = [];
  const scheduler = new RoomStatusScheduler({
    getRooms: () => rooms,
    check: async (room) => {
      active++;
      peak = Math.max(peak, active);
      await wait(5);
      checked.push(room.id);
      active--;
    },
    concurrency: 3,
    intervalMs: 60_000,
    jitterMs: 0,
    documentRef: { hidden: false },
    navigatorRef: { onLine: true },
  });
  scheduler.start();
  await wait(40);
  scheduler.stop();
  assert.equal(peak, 3);
  assert.deepEqual(checked.sort((a, b) => a - b), rooms.map((room) => room.id));
});

test('hidden pages check open rooms and subscribed closed rooms only', async () => {
  const rooms = [
    { id: 'open', nextCheckAt: 0 },
    { id: 'closed', nextCheckAt: 0 },
    { id: 'subscribed', nextCheckAt: 0, s: { notifyOnLive: true } },
  ];
  const checked = [];
  const scheduler = new RoomStatusScheduler({
    getRooms: () => rooms,
    isOpen: (room) => room.id === 'open',
    check: async (room) => checked.push(room.id),
    intervalMs: 60_000,
    jitterMs: 0,
    documentRef: { hidden: true },
    navigatorRef: { onLine: true },
  });
  scheduler.start();
  await wait(10);
  scheduler.stop();
  assert.deepEqual(checked, ['open', 'subscribed']);
  rooms[2].s.notifyOnLive = false;
  assert.equal(scheduler.eligible(rooms[2], Date.now() + 120_000), false);
});
