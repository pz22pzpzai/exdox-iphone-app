# Exdox iPhone App

Exdox for iPhone is a React Native expenses app built with Expo and TypeScript. It is maintained separately from the Android repository so iOS build and App Store work cannot affect Android releases.

Repository: `https://github.com/pz22pzpzai/exdox-iphone-app`

## What it does

- Capture new receipts and invoices with the camera
- Import images or PDF files from the phone
- Process receipts and invoices through a secure backend OCR proxy
- Sync purchases, sales, claims, mileage, settings and supporting evidence with the Exdox workspace
- Review and manage receipt, invoice and reimbursement workflows
- Use secure Face ID or device authentication after the first successful sign-in
- Retain a scoped local workspace cache while the production server remains authoritative

## Main files

- `App.tsx` contains the app shell and screen flow
- `src/components` contains reusable cards
- `src/data/seed.ts` defines the blank first-launch state
- `src/utils/storage.ts` handles local persistence
- `src/utils/documents.ts` creates imported draft documents
- `src/services/documentExtraction.ts` uploads files to the secure backend OCR proxy
- `src/utils/uploadAsset.ts` compresses mobile image uploads before sending them

## Production services

The app uses the same production Exdox server contract as the Android app:

- API: `https://hz2zkm6jkf.execute-api.eu-west-2.amazonaws.com/prod`
- Secure extraction: `https://hz2zkm6jkf.execute-api.eu-west-2.amazonaws.com/prod/api/v1/expenses/process`

The mobile app reads `EXPO_PUBLIC_EXPENSES_API_URL` only when an explicit non-production endpoint override is needed at build time. Never commit credentials or private environment values.

## Validate locally

1. Install dependencies with `npm install`
2. Run `npm run typecheck`
3. Run `npx expo config --type public`
4. Run `npx expo-doctor`

## Build for iPhone

Use Expo EAS from the short local build path:

- `npm run ios:build:preview` for a registered-device preview build.
- `npm run ios:build:production` for TestFlight/App Store.
- `npm run ios:submit` to submit the production build.

Apple Developer Program and Expo account access are required for signed distribution builds.
