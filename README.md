# Exdox iPhone App

Exdox for iPhone is a React Native expenses app built with Expo and TypeScript. It is maintained separately from the Android repository so iOS build and App Store work cannot affect Android releases.

## What it does

- Capture new receipts and invoices with the camera
- Import images or PDF files from the phone
- Process receipts and invoices through a secure backend OCR proxy
- Separate receipt and invoice workflows
- Group receipts into draft expense claims
- Persist everything on-device with no bank feed or accounting integration

## Main files

- `App.tsx` contains the app shell and screen flow
- `src/components` contains reusable cards
- `src/data/seed.ts` defines the blank first-launch state
- `src/utils/storage.ts` handles local persistence
- `src/utils/documents.ts` creates imported draft documents
- `src/services/documentExtraction.ts` uploads files to the secure backend OCR proxy
- `src/utils/uploadAsset.ts` compresses mobile image uploads before sending them

## Backend OCR proxy

The secure OCR proxy lives in `../server`.

1. Copy `server/.env.example` to `server/.env`
2. Set `OPENAI_API_KEY` on the server environment
3. Install server dependencies with `npm install`
4. Start the API with `npm run dev` for development or `npm run build && npm run start` for production

The mobile app reads `EXPO_PUBLIC_EXPENSES_API_URL` if you want to override the default backend URL at build time.

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
