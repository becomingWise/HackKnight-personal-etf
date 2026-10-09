import Link from "next/link";

export default function NotFound() {
  return (
    <section className="rounded-panel border border-line bg-surface p-8">
      <p className="text-xs font-semibold tracking-[0.18em] text-muted">404</p>
      <h1 className="mt-1 text-2xl font-semibold">Nothing here yet.</h1>
      <p className="mt-2 text-muted">This page doesn&apos;t exist, or it is still being built.</p>
      <Link href="/" className="mt-5 inline-block text-blue underline">
        Back to the start
      </Link>
    </section>
  );
}
