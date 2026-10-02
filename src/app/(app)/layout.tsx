import Image from "next/image";
import { ASSET_VERSION } from "@/lib/asset-version";
import { LogoutButton } from "./LogoutButton";
import { NavLinks } from "./NavLinks";
import { ThemeToggle } from "./ThemeToggle";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 px-4 lg:px-5">
        <Image
          src={`/logo.png?v=${ASSET_VERSION}`}
          alt=""
          width={30}
          height={30}
          className="rounded-[9px] shadow-md"
          priority
        />
        <h1 className="text-[15px] font-semibold tracking-tight">File Optimizer</h1>
        <div className="ml-4">
          <NavLinks />
        </div>
        <div className="ml-auto flex items-center gap-0.5">
          <ThemeToggle />
          <LogoutButton />
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 pb-8 lg:px-5">{children}</main>
    </div>
  );
}
