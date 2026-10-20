import Link from "next/link";

const cards = [
  { href: "/index", title: "Index", body: "Chunk, embed and document every configured repo, and watch progress live." },
  { href: "/query", title: "Query", body: "Sanity-check retrieval: describe a feature and see which code, CLAUDE.md and mindmap context comes back." },
];

export default function Home() {
  return (
    <div>
      <h1 className="text-2xl font-semibold">sdd-poc — Context Agent</h1>
      <p className="mt-2 text-slate-600">Index your repos first, then verify retrieval before building the Requirement Agent on top.</p>
      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        {cards.map((c) => (
          <Link key={c.href} href={c.href} className="rounded-lg border bg-white p-5 shadow-sm hover:border-slate-400">
            <div className="text-lg font-medium">{c.title}</div>
            <p className="mt-1 text-sm text-slate-600">{c.body}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
