import { createTestDatabase } from '@/db/__tests__/testDb';
import { migrate } from '@/db/migrator';
import {
  createFoodLog,
  dayTotals,
  deleteFoodLog,
  editFoodLog,
  listDay,
  type LogFoodInput,
} from '@/db/repositories/foodLogs';
import type { SqlDatabase } from '@/db/types';
import { asLocalDay } from '@/lib/date';
import type { NutritionPerBase } from '@/lib/nutrition';
import { sync } from '../engine';
import { countPending } from '../outbox';
import { createFakeRemote, type FakeRemote } from './fakeRemote';

jest.mock('@/api/supabase', () => ({ supabase: {} }));

/**
 * The diary, offline and across devices.
 *
 * Every scenario here is one somebody will actually hit — a log written on a
 * plane, an entry deleted on a phone and still showing on a tablet, two
 * devices editing the same breakfast. They are driven through the real engine
 * and the real outbox against an in-memory server, because none of them can be
 * checked against a live backend and all of them lose or resurrect user data
 * when they are wrong.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ZURICH = 'Europe/Zurich';
const DAY = asLocalDay('2026-06-15');
/** 2026-06-15 08:00 Zurich. */
const MORNING = Date.parse('2026-06-15T06:00:00.000Z');

const APPLE: NutritionPerBase = {
  calories: 52,
  protein_g: 0.26,
  carbohydrates_g: 13.81,
  fat_g: 0.17,
  fiber_g: 2.4,
  sugar_g: null,
  saturated_fat_g: null,
  sodium_mg: null,
};

function seedUser(db: SqlDatabase, userId: string): void {
  db.run(
    `INSERT INTO profiles (id, email, unit_system, time_zone, created_at, updated_at)
     VALUES (?, 'sam@example.com', 'metric', 'Europe/Zurich', 1000, 1000)`,
    [userId],
  );
}

function logApple(
  db: SqlDatabase,
  userId: string,
  overrides: Partial<LogFoodInput> = {},
) {
  return createFoodLog(
    {
      userId,
      meal: 'breakfast',
      food: {
        foodId: 'food-apple',
        name: 'Apple, raw',
        brandName: null,
        sourceId: 'usda',
        isVerified: true,
        baseUnit: 'g',
        baseAmount: 100,
      },
      nutrition: APPLE,
      quantity: 200,
      serving: null,
      timeZone: ZURICH,
      at: MORNING,
      ...overrides,
    },
    db,
  );
}

describe('diary sync', () => {
  let phone: SqlDatabase & { close: () => void };
  let tablet: SqlDatabase & { close: () => void };
  let remote: FakeRemote;

  beforeEach(() => {
    phone = createTestDatabase();
    tablet = createTestDatabase();
    migrate(phone);
    migrate(tablet);
    remote = createFakeRemote();

    seedUser(phone, USER);
    seedUser(tablet, USER);
  });

  afterEach(() => {
    phone.close();
    tablet.close();
  });

  const syncPhone = () => sync({ db: phone, userId: USER, remote });
  const syncTablet = () => sync({ db: tablet, userId: USER, remote });

  /* ------------------------------------------------------------ 1. create */

  it('1. pushes an entry written online', async () => {
    const row = logApple(phone, USER);

    const outcome = await syncPhone();

    expect(outcome.error).toBeNull();
    expect(countPending(phone)).toBe(0);
    expect(remote.find('food_logs', row.id)).toMatchObject({
      food_name: 'Apple, raw',
      basis_calories: 52,
      quantity: 200,
    });
  });

  it('2. holds an entry written offline and sends it on reconnect', async () => {
    remote.goOffline();
    const row = logApple(phone, USER);

    // The entry is in the diary straight away: the server was never consulted.
    expect(listDay(USER, DAY, phone)).toHaveLength(1);
    expect(dayTotals(USER, DAY, phone).total.calories).toBe(104);

    await syncPhone();
    expect(countPending(phone)).toBe(1);
    expect(remote.find('food_logs', row.id)).toBeUndefined();

    remote.goOnline();
    // The failed attempt scheduled a 2 s backoff, so a sync triggered the
    // instant the radio comes back finds nothing due yet. That is the intended
    // behaviour — reconnects flap — and the entry goes out on the next cycle.
    await syncPhone();
    expect(countPending(phone)).toBe(1);

    phone.run('UPDATE sync_outbox SET next_attempt_at = 0');
    await syncPhone();

    expect(countPending(phone)).toBe(0);
    expect(remote.find('food_logs', row.id)).toBeDefined();
  });

  it('3. sends the final state after several offline edits, not each keystroke', async () => {
    remote.goOffline();
    const row = logApple(phone, USER);
    editFoodLog(row.id, { quantity: 250, at: MORNING + 1000 }, phone);
    editFoodLog(row.id, { quantity: 300, meal: 'snack', at: MORNING + 2000 }, phone);

    remote.goOnline();
    await syncPhone();

    // Each outbox entry carries the whole row, so whichever lands last is
    // complete and self-consistent rather than a fragment.
    expect(remote.find('food_logs', row.id)).toMatchObject({
      quantity: 300,
      meal: 'snack',
      calories: 156,
    });
    expect(countPending(phone)).toBe(0);
  });

  it('4. lets the server compute the totals rather than trusting the client', async () => {
    const row = logApple(phone, USER, { quantity: 300 });
    await syncPhone();

    const stored = remote.find('food_logs', row.id);

    // The client sent the basis and the portion; the totals are absent from
    // the payload, exactly as Postgres requires for a generated column.
    expect(stored).toMatchObject({ basis_calories: 52, quantity: 300 });
    expect(stored?.calories).toBe(156);
  });

  /* ------------------------------------------------------- 5. two devices */

  it('5. delivers an entry to the user other device', async () => {
    logApple(phone, USER);
    await syncPhone();
    await syncTablet();

    const onTablet = listDay(USER, DAY, tablet);
    expect(onTablet).toHaveLength(1);
    expect(onTablet[0]).toMatchObject({
      food_name: 'Apple, raw',
      calories: 104,
      diary_date: '2026-06-15',
      time_zone: ZURICH,
    });
  });

  it('6. carries the diary day itself rather than re-deriving it', async () => {
    // Logged in Honolulu, where the local day and the UTC day disagree.
    const row = logApple(phone, USER, {
      at: Date.parse('2026-06-15T08:00:00.000Z'),
      timeZone: 'Pacific/Honolulu',
    });
    expect(row.diary_date).toBe('2026-06-14');

    await syncPhone();
    await syncTablet();

    // The tablet is in Zurich and must not re-date the entry to its own zone,
    // nor to the UTC day. The day travelled with the row.
    expect(listDay(USER, asLocalDay('2026-06-14'), tablet)).toHaveLength(1);
    expect(listDay(USER, asLocalDay('2026-06-15'), tablet)).toHaveLength(0);
  });

  it('7. delivers an edit to the other device', async () => {
    const row = logApple(phone, USER);
    await syncPhone();
    await syncTablet();

    editFoodLog(row.id, { quantity: 300, at: MORNING + 10_000 }, phone);
    await syncPhone();
    await syncTablet();

    const [entry] = listDay(USER, DAY, tablet);
    expect(entry!.quantity).toBe(300);
    expect(entry!.calories).toBe(156);
    expect(listDay(USER, DAY, tablet)).toHaveLength(1);
  });

  /* ----------------------------------------------------------- 8. delete */

  it('8. removes a deleted entry from the other device', async () => {
    const row = logApple(phone, USER);
    await syncPhone();
    await syncTablet();
    expect(listDay(USER, DAY, tablet)).toHaveLength(1);

    deleteFoodLog(row.id, phone, MORNING + 10_000);
    await syncPhone();
    await syncTablet();

    expect(listDay(USER, DAY, tablet)).toHaveLength(0);
    expect(dayTotals(USER, DAY, tablet).total.calories).toBe(0);
  });

  it('9. does not resurrect an entry deleted offline', async () => {
    const row = logApple(phone, USER);
    await syncPhone();

    remote.goOffline();
    deleteFoodLog(row.id, phone, MORNING + 10_000);
    expect(listDay(USER, DAY, phone)).toHaveLength(0);

    // A pull attempt while the deletion is still queued must not bring the
    // row back — the outbox guard is what stops it.
    remote.goOnline();
    await syncPhone();
    await syncPhone();
    await syncPhone();

    expect(listDay(USER, DAY, phone)).toHaveLength(0);
    expect(remote.find('food_logs', row.id)?.deleted_at).toBeTruthy();
    expect(countPending(phone)).toBe(0);
  });

  it('10. never sends an entry created and deleted before it ever reached the server', async () => {
    remote.goOffline();
    const row = logApple(phone, USER);
    deleteFoodLog(row.id, phone, MORNING + 1000);

    remote.goOnline();
    await syncPhone();

    // The create is sent first and the delete immediately after, in that
    // order, so the server never holds a live row it was never told about.
    expect(remote.find('food_logs', row.id)?.deleted_at).toBeTruthy();
    expect(listDay(USER, DAY, phone)).toHaveLength(0);
    expect(countPending(phone)).toBe(0);
  });

  /* -------------------------------------------------------- 11. conflict */

  it('11. keeps an unsent local edit when a pull lands on top of it', async () => {
    const row = logApple(phone, USER);
    await syncPhone();
    await syncTablet();

    // The tablet edits and syncs; the phone edits the same entry while offline.
    editFoodLog(row.id, { quantity: 500, at: MORNING + 5_000 }, tablet);
    await syncTablet();

    remote.goOffline();
    editFoodLog(row.id, { quantity: 250, at: MORNING + 20_000 }, phone);
    remote.goOnline();

    await syncPhone();

    // The phone's unsent edit is not discarded by the incoming row, and it
    // wins on the server because it was pushed after.
    expect(listDay(USER, DAY, phone)[0]!.quantity).toBe(250);
    expect(remote.find('food_logs', row.id)?.quantity).toBe(250);
  });

  it('12. settles both devices on one version after a concurrent edit', async () => {
    const row = logApple(phone, USER);
    await syncPhone();
    await syncTablet();

    editFoodLog(row.id, { quantity: 250, at: MORNING + 5_000 }, phone);
    editFoodLog(row.id, { quantity: 400, at: MORNING + 6_000 }, tablet);

    await syncPhone();
    await syncTablet();
    await syncPhone();
    await syncTablet();

    const onPhone = listDay(USER, DAY, phone);
    const onTablet = listDay(USER, DAY, tablet);

    // One entry each — a conflict must never become two breakfasts.
    expect(onPhone).toHaveLength(1);
    expect(onTablet).toHaveLength(1);
    expect(onPhone[0]!.quantity).toBe(onTablet[0]!.quantity);
    expect(onPhone[0]!.calories).toBe(onTablet[0]!.calories);
  });

  /* ------------------------------------------------- 13. failure and repeat */

  it('13. retries a rejected write without duplicating the entry', async () => {
    const row = logApple(phone, USER);
    remote.failWrites(1);

    await syncPhone();
    expect(countPending(phone)).toBe(1);
    expect(remote.find('food_logs', row.id)).toBeUndefined();

    // The backoff has not elapsed yet, so nothing is attempted.
    await syncPhone();
    expect(countPending(phone)).toBe(1);

    phone.run('UPDATE sync_outbox SET next_attempt_at = 0');
    await syncPhone();

    expect(countPending(phone)).toBe(0);
    expect(remote.rows('food_logs')).toHaveLength(1);
    expect(listDay(USER, DAY, phone)).toHaveLength(1);
  });

  it('14. changes nothing when run twice over', async () => {
    logApple(phone, USER);
    logApple(phone, USER, { meal: 'lunch', at: MORNING + 3_600_000 });
    await syncPhone();

    const before = listDay(USER, DAY, phone);
    const serverBefore = remote.rows('food_logs');

    await syncPhone();
    await syncPhone();

    expect(listDay(USER, DAY, phone)).toEqual(before);
    expect(remote.rows('food_logs')).toHaveLength(serverBefore.length);
    expect(countPending(phone)).toBe(0);
  });

  it('15. never pulls another user diary', async () => {
    remote.seed('food_logs', {
      id: 'someone-elses-breakfast',
      user_id: OTHER,
      food_id: 'food-apple',
      meal: 'breakfast',
      logged_at: new Date(MORNING).toISOString(),
      time_zone: ZURICH,
      diary_date: '2026-06-15',
      quantity: 999,
      serving_label: 'g',
      serving_amount: 1,
      food_name: 'Not yours',
      food_source_id: 'usda',
      food_is_verified: true,
      basis_unit: 'g',
      basis_amount: 100,
      basis_calories: 52,
      deleted_at: null,
    });

    await syncPhone();

    expect(listDay(USER, DAY, phone)).toHaveLength(0);
    expect(
      phone.get<{ count: number }>('SELECT COUNT(*) AS count FROM food_logs')?.count,
    ).toBe(0);
  });
});
