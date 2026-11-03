import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { Accounts } from './accounts/accounts.ts';
import { Sessions } from './accounts/sessions.ts';
import { SetupCodes } from './accounts/setupCodes.ts';
import { loadConfig } from './config.ts';
import { openDatabase } from './db.ts';

/**
 * Owner recovery, on the server host only (nobody on the network can do this): the account is signed
 * out everywhere and gets a setup code to choose a new password with. Its old password ends too, unless
 * it's the only one on the server: then nobody could sign in and the server would be back in setup mode,
 * open to anyone at home, until the code is used. Redeeming the code replaces it either way.
 */
export function resetPassword(db: DatabaseSync, username: string, origin: string): { name: string; code: string; link: string; expiresAt: string } {
  const accounts = new Accounts(db);
  const account = accounts.byUsername(username);
  if (!account) throw new Error(`No account named ${username.trim()}`);
  const othersCanSignIn = accounts.list().some((a) => a.id !== account.id && a.hasPassword);
  if (othersCanSignIn) accounts.clearPassword(account.id);
  new Sessions(db).removeAll(account.id);
  return { name: account.name, ...new SetupCodes(db).issue(account.id, origin) };
}

function main(args: string[]) {
  const [command, username] = args;
  if (command !== 'reset-password' || !username) {
    console.error('Usage: node dist/cli.js reset-password <username>');
    return 1;
  }
  const config = loadConfig();
  const db = openDatabase(resolve(config.DATA_DIR));
  // The server may be running and writing too: wait for it rather than fail.
  db.exec('PRAGMA busy_timeout = 5000');
  try {
    const reset = resetPassword(db, username, config.PUBLIC_URL ?? `http://localhost:${config.PORT}`);
    console.log(`Signed ${reset.name} out everywhere. Set a new password within 7 days:\n  code: ${reset.code}\n  link: ${reset.link}`);
    return 0;
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));
