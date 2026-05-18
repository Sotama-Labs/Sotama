import { NextResponse, type NextRequest } from "next/server";

const BETA_HOST = "beta.sotama.xyz";

export function middleware(request: NextRequest) {
  const host = request.headers.get("host")?.split(":")[0]?.toLowerCase();

  if (host === BETA_HOST) {
    return NextResponse.rewrite(new URL("/maintenance", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/"],
};
