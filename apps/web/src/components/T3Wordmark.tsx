import type { SVGProps } from "react";

// Robob mark. Keeps the upstream component name so call sites stay merge-friendly.
export function T3Wordmark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
      <image href="/favicon-32x32.png" width="32" height="32" />
    </svg>
  );
}
