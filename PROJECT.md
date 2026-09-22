# Exdox iPhone App — Operational Context

## Purpose

This is the iPhone-only Exdox mobile application. It is derived from the shared React Native/Expo Android application but maintained in a separate repository so iOS configuration and release work cannot change the Android app.

Production website: `https://exdox.co.uk`  
Production API: `https://hz2zkm6jkf.execute-api.eu-west-2.amazonaws.com/prod`  
Production extraction endpoint: `https://hz2zkm6jkf.execute-api.eu-west-2.amazonaws.com/prod/api/v1/expenses/process`
GitHub repository: `https://github.com/pz22pzpzai/exdox-iphone-app`
Expo project: `https://expo.dev/accounts/pz22pzpz/projects/exdox-iphone-app`  
Expo project ID: `36255ac4-857b-4088-9129-bdca46016141`

## Main files

- `App.tsx`: app shell and mobile workflow UI.
- `src/services/`: authentication, settings, extraction, receipt, sales and claims API clients.
- `src/utils/`: secure authentication storage, local workspace storage and upload preparation.
- `app.json`: iPhone identifier, permissions and Expo configuration.
- `eas.json`: preview, production and App Store submission profiles.

## Build and release

- Build from a short local non-synced path such as `C:\b\exdox-iphone-app`.
- Install dependencies with the workspace-bundled Node/npm runtime when npm is not available on PATH.
- Validate with `npm run typecheck`, `npx expo config --type public` and `npx expo-doctor`.
- Create iOS builds using Expo EAS cloud builds; iOS compilation runs on a managed macOS builder.
- Upload production builds to App Store Connect and distribute beta builds through TestFlight.
- BrowserStack App Live can install the TestFlight build on cloud-hosted real iPhones for testing.

## Important constraints

- This repository is iPhone-only. Do not change the separate Android repository while making iOS changes.
- Keep the production API paths aligned with the Android app unless the backend contract changes for both clients.
- App changes require a freshly verified iOS build, Google Drive delivery to `Exdox iPhone App`, and a GitHub push.
- Keep only the latest two iOS build artifacts locally, but never delete any Android APK or Android release asset.
- Never delete, move, expose or alter any Android keystore, Apple certificate, provisioning profile, private key or signing detail.
- Never commit credentials, secrets, machine-specific signing files, `.env` files or generated native directories.
- Do not claim physical iPhone testing unless a physical or cloud-hosted real iPhone was actually used.

## Current iOS adaptation

- The app targets iPhone only with bundle identifier `uk.co.exdox.mobile`.
- Camera, photo library, document picker and Face ID permission descriptions are configured.
- All existing Exdox production API clients are retained.
- Business owners can initiate authenticated permanent workspace/account deletion from Settings using the production `DELETE /account` endpoint.
- TypeScript validation and the production-mode iOS JavaScript bundle pass.
- Expo Doctor passes its local project, dependency, SDK compatibility, peer dependency and store-submission checks; its remote schema lookup can fail on this Windows network before TLS negotiation.
- All mobile API route definitions match the backend infrastructure template, and unauthenticated CORS preflight requests reached the production login, receipts, claims, sales workspace, settings, account deletion and extraction routes successfully on 2026-09-22.
- The App Store icon is 1024 by 1024 pixels and fully opaque.
- The repository is linked to the `pz22pzpz` Expo account for EAS cloud builds. Signed TestFlight work still requires an active Apple Developer Program account and Apple signing credentials.
