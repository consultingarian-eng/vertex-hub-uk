/**
 * The password someone just signed in with, held in memory only (never
 * stored), for the one case that needs it again: an account on the shared
 * starter password goes straight to "choose your own password", and should not
 * have to type the starter one a second time. A page reload forgets it, and
 * the screen then asks for it.
 */
let held: string | null = null;

export const holdStarterPassword = (password: string) => { held = password; };
export const heldStarterPassword = () => held;
export const forgetStarterPassword = () => { held = null; };
