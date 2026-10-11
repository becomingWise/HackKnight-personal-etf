import { Builder } from "./builder";
import { PITCH } from "./productView";

export default function Home() {
  return (
    <div className="grid gap-6">
      <h1 className="max-w-3xl text-3xl font-bold tracking-tight sm:text-4xl">{PITCH}</h1>
      <Builder />
    </div>
  );
}
