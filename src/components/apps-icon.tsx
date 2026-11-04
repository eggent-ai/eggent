/**
 * The sidebar's mark for Apps: four small blocks whose colours drift slowly
 * through a soft palette, each on its own beat, and whose loose block settles
 * into place under the pointer. Colours and timing live in globals.css
 * (.eggent-apps-cube); under reduced motion the blocks keep their colours and
 * stay still.
 */
export function AppsIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={`eggent-apps-icon ${className ?? ""}`} aria-hidden="true" focusable="false">
      <rect className="eggent-apps-cube" style={{ animationDelay: "0s" }} x="3" y="13" width="8" height="8" rx="2" />
      <rect className="eggent-apps-cube" style={{ animationDelay: "-2.5s" }} x="13" y="13" width="8" height="8" rx="2" />
      <rect className="eggent-apps-cube" style={{ animationDelay: "-5s" }} x="3" y="3" width="8" height="8" rx="2" />
      <rect className="eggent-apps-cube eggent-apps-cube-loose" style={{ animationDelay: "-7.5s" }} x="13" y="3" width="8" height="8" rx="2" />
    </svg>
  );
}
