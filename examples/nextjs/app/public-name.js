"use client";

export function PublicName() {
  return <code id="public-name">{process.env.NEXT_PUBLIC_EXAMPLE_NAME}</code>;
}
