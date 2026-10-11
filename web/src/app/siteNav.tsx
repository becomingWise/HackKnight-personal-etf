"use client";

// The header links, with the current page marked. Shown on every page of the Next app; the Lab
// (a static page) carries the same links in its own header (scripts/sync-lab.mjs).
import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV, isCurrent } from "./productView";

export function SiteNav() {
  const pathname = usePathname() ?? "/";
  return (
    <nav aria-label="Main" className="-mx-2 max-w-full overflow-x-auto">
      <ul className="flex items-center gap-0.5 text-[13px] font-medium whitespace-nowrap sm:gap-1 sm:text-sm">
        {NAV.map((item) => {
          const current = isCurrent(item.href, pathname);
          const style = `block rounded-full px-1.5 py-1.5 sm:px-3 ${
            current ? "bg-blue-soft text-blue" : "text-muted hover:text-ink"
          }`;
          return (
            <li key={item.href}>
              {item.fullLoad ? (
                <a href={item.href} className={style}>
                  {item.label}
                </a>
              ) : (
                <Link
                  href={item.href}
                  className={style}
                  aria-current={current ? "page" : undefined}
                >
                  {item.label}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
