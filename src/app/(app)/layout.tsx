import Link from "next/link";
import { LogoutButton } from "./LogoutButton";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header className="border-b border-zinc-200 bg-white">
        <nav className="mx-auto flex max-w-5xl items-center gap-6 px-6 py-4">
          <Link href="/" className="font-semibold">
            Optimize files
          </Link>
          <Link href="/" className="text-sm text-zinc-600 hover:text-zinc-900">
            Parcourir
          </Link>
          <Link href="/jobs" className="text-sm text-zinc-600 hover:text-zinc-900">
            Traitements
          </Link>
          <span className="ml-auto flex items-center gap-4">
            <LogoutButton />
          </span>
        </nav>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8">{children}</main>
    </>
  );
}
