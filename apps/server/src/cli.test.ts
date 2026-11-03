import { describe, expect, it } from 'vitest';
import { Accounts } from './accounts/accounts.ts';
import { Sessions } from './accounts/sessions.ts';
import { SetupCodes } from './accounts/setupCodes.ts';
import { freshDb } from './catalog/testFixtures.ts';
import { resetPassword } from './cli.ts';

async function setup() {
  const db = freshDb();
  const accounts = new Accounts(db);
  const sessions = new Sessions(db);
  await accounts.setPassword(1, 'forgotten one');
  accounts.update(1, { username: 'nicola', name: 'Nicola' });
  const phone = sessions.create(1, 'iPhone', 'ios').token;
  return { db, accounts, sessions, setupCodes: new SetupCodes(db), phone };
}

describe('reset-password', () => {
  it('signs the account out everywhere and gives a setup code that sets a new password', async () => {
    const { db, accounts, sessions, setupCodes, phone } = await setup();
    const reset = resetPassword(db, ' Nicola ', 'https://music.example.com');
    expect(reset.name).toBe('Nicola');
    expect(reset.code).toMatch(/^[A-HJKMNP-Z2-9]{8}$/);
    expect(reset.link).toBe(`https://music.example.com/redeem?code=${reset.code}`);
    expect(sessions.resolve(phone)).toBeUndefined();
    // Redeemed as POST /api/auth/redeem does.
    const id = setupCodes.accountFor(reset.code)!;
    expect(id).toBe(1);
    await accounts.setPassword(id, 'remembered one');
    setupCodes.use(reset.code);
    expect(await accounts.verify('nicola', 'remembered one')).toMatchObject({ id: 1 });
    expect(await accounts.verify('nicola', 'forgotten one')).toBeNull();
  });

  it('ends the old password when someone else can still sign in, and keeps it when it’s the only one', async () => {
    const { db, accounts } = await setup();
    // The only password: clearing it would reopen setup mode to anyone at home until the code is used.
    resetPassword(db, 'nicola', 'http://localhost:4000');
    expect(new Accounts(db).setupMode()).toBe(false);
    expect(await accounts.verify('nicola', 'forgotten one')).toMatchObject({ id: 1 });
    const sam = accounts.create({ username: 'sam', name: 'Sam', role: 'member', canRequest: false, sources: null });
    await accounts.setPassword(sam.id, 'sams password');
    resetPassword(db, 'nicola', 'http://localhost:4000');
    expect(await accounts.verify('nicola', 'forgotten one')).toBeNull();
    expect(new Accounts(db).setupMode()).toBe(false);
  });

  it('names an unknown username', async () => {
    const { db } = await setup();
    expect(() => resetPassword(db, 'nobody', 'http://localhost:4000')).toThrow('No account named nobody');
  });
});
