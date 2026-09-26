This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://github.com/vercel/next.js/tree/canary/packages/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.js`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Checking it still works

```bash
npm test          # the logic that has no React and no network in it
npm run build     # the portal itself compiles
```

`tests/fees.test.mjs` covers the part of the `crawl-school-fees` edge function that decides what a number on a
school website means. The function is one file because it is pasted into the Supabase dashboard, so the part worth
testing is marked off inside it with `==== BEGIN testable logic` and lifted out by the test. Node reads the
TypeScript directly; nothing needs installing.

`tests/fee-findings.test.mjs` covers the portal side: how those readings are arranged and what stops one being
saved as a real fee.

Migrations are pasted in by hand, so run `supabase/which-migrations-have-run.sql` in the SQL editor to see which
ones are already there.
