import logo from "./ukt-logo.svg";

/** The company mark (the HR sidebar's UKTLogo, as an image): the MD shell has its own copy so it does not pull the whole
 *  HR sidebar module into the MD portal just for the logo. Small enough to be inlined into the bundle. */
export default function UktLogo({ className }: { className?: string }) {
  return <img src={logo} alt="UKTextiles Logo" className={className} draggable={false} />;
}
