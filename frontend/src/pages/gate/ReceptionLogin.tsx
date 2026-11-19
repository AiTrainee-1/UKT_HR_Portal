// The old per-desk sign-in link /reception-login/<token> is now the shared reception sign-in, which shows that desk's
// name as a hint (./reception/ReceptionSignIn.tsx: its own client, never the HR token). This file keeps the address
// App.tsx imports.
export { default } from "./reception/ReceptionSignIn";
