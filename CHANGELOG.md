# Changelog

## [1.0.0](https://github.com/dannycalleri/turbo-vibe/compare/v1.0.0-rc.7...v1.0.0) (2026-10-20)


### Miscellaneous Chores

* release 1.0.0 ([7f81d97](https://github.com/dannycalleri/turbo-vibe/commit/7f81d97c2c75f6965346612fa655eac318801441))

## [1.0.0-rc.7](https://github.com/dannycalleri/turbo-vibe/compare/v1.0.0-rc.6...v1.0.0-rc.7) (2026-10-18)


### Bug Fixes

* **check:** give a token that counts visits Account Settings Read ([55cc56b](https://github.com/dannycalleri/turbo-vibe/commit/55cc56b5bd744d52820860f12f9897a521361e4c))
* **check:** give a token that counts visits Account Settings Read ([b3e8ab5](https://github.com/dannycalleri/turbo-vibe/commit/b3e8ab5cc19c2f44699f35fd865438f37ce44622))

## [1.0.0-rc.6](https://github.com/dannycalleri/turbo-vibe/compare/v1.0.0-rc.5...v1.0.0-rc.6) (2026-10-18)


### Features

* **cloudflare:** stop a 404-page deploy whose build has no 404.html ([fd1e978](https://github.com/dannycalleri/turbo-vibe/commit/fd1e978c22c9153216fe3756ca1e0d215a7c82fc))
* **config:** not_found answers a missing page with 404 and the site's 404.html ([70cd4fc](https://github.com/dannycalleri/turbo-vibe/commit/70cd4fc23e387c3a1f4f8bfc9f49db857f345dd6))
* **config:** not_found chooses a frontend's answer to a missing page ([631498d](https://github.com/dannycalleri/turbo-vibe/commit/631498d057d21718bbc222f1a3851efda8225e6e))

## [1.0.0-rc.5](https://github.com/dannycalleri/turbo-vibe/compare/v1.0.0-rc.4...v1.0.0-rc.5) (2026-10-16)


### Features

* **cloudflare:** keep every environment but production out of search engines ([221f382](https://github.com/dannycalleri/turbo-vibe/commit/221f38267f3c20c2863dca268849f8c9cf148f8d))
* **cloudflare:** redirect HTTP to HTTPS from staging and production ([798ce6d](https://github.com/dannycalleri/turbo-vibe/commit/798ce6d90169f11f50493a36a9ac534b29a3f0ab))
* **cloudflare:** redirect HTTP to HTTPS on the zone from staging and production ([16ef509](https://github.com/dannycalleri/turbo-vibe/commit/16ef509c57db2cb07bda42ccb01d89895c1faeee))
* **config:** count visits with Cloudflare Web Analytics ([40dc834](https://github.com/dannycalleri/turbo-vibe/commit/40dc834293286ba197abb1312eab923a08d088e4))
* **config:** count visits with Cloudflare Web Analytics ([15f9ee7](https://github.com/dannycalleri/turbo-vibe/commit/15f9ee766678d838e27fda51da0a00b5275061c5))
* **config:** private environments behind Cloudflare Access ([b03b0a2](https://github.com/dannycalleri/turbo-vibe/commit/b03b0a272a9528508c1902f6db34dc2c39abe7a6))
* **config:** private environments behind Cloudflare Access, and noindex outside production ([eac61fa](https://github.com/dannycalleri/turbo-vibe/commit/eac61faa9090b3ee9508e7930bd17aabc0bab7e6))

## [1.0.0-rc.4](https://github.com/dannycalleri/turbo-vibe/compare/v1.0.0-rc.3...v1.0.0-rc.4) (2026-10-16)


### Features

* **assistant:** the guidance walks the person through each token's steps ([cd87287](https://github.com/dannycalleri/turbo-vibe/commit/cd8728737f28d52c522e95ff9f48867e36ebe33c))
* **init:** add .turbo-vibe/ to .gitignore ([43d14f6](https://github.com/dannycalleri/turbo-vibe/commit/43d14f6dea1398975563c020bd37ba5fa7fc68d6))
* **init:** ask with arrow-key choices and re-ask an invalid answer ([5391a33](https://github.com/dannycalleri/turbo-vibe/commit/5391a335ef31e7572e12151dd2ba0a2490e29d4f))
* **init:** end with numbered next steps and offer to run setup ([682833f](https://github.com/dannycalleri/turbo-vibe/commit/682833fd8ec679091682df773079f0ff17a12bd2))
* **init:** offer defaults read from the repository ([b3a3047](https://github.com/dannycalleri/turbo-vibe/commit/b3a3047e2c0b51ea0ca50c5464faa4a0172018df))
* **setup:** guide the Cloudflare step and read the account from the token ([80ade91](https://github.com/dannycalleri/turbo-vibe/commit/80ade913be04c3f553a04417e39dbf568aadd03e))
* **setup:** guide the Supabase, Vercel and WorkOS steps and check each value at once ([7bad1e4](https://github.com/dannycalleri/turbo-vibe/commit/7bad1e4c3dd910d0dc2174bf55754b7c37ed8554))
* **setup:** one table of vendor steps for setup --list, the checklist and the agent guidance ([bfb84e8](https://github.com/dannycalleri/turbo-vibe/commit/bfb84e8d493d120c136d5231cfb57a9d3b8b7b9c))
* **setup:** open a Cloudflare token page prefilled with the one permission ([ea78853](https://github.com/dannycalleri/turbo-vibe/commit/ea788535ec31f540b8f0c0fa8457731912f80448))
* **setup:** setup --list prints each token's steps from the same table as setup ([461fce0](https://github.com/dannycalleri/turbo-vibe/commit/461fce0a98bbd2feca4524791f375f699a6ae361))


### Bug Fixes

* **cloudflare:** name session-routed instances after the build, so a deploy switches at once ([decc693](https://github.com/dannycalleri/turbo-vibe/commit/decc693148dc986b87c508279591743b9280b1ec))
* **cloudflare:** name session-routed instances after the build, so a deploy switches at once ([ebb57d6](https://github.com/dannycalleri/turbo-vibe/commit/ebb57d6afb60a890dadff0536725aa7c74f99386))

## [1.0.0-rc.3](https://github.com/dannycalleri/turbo-vibe/compare/v1.0.0-rc.2...v1.0.0-rc.3) (2026-10-16)


### Features

* **init:** --assistant takes a list, and defaults to the assistants the repository uses ([6dd7dff](https://github.com/dannycalleri/turbo-vibe/commit/6dd7dffb17746856b3856ef53e1a1ae5da9466e6))
* **init:** --assistant takes a list, and defaults to the assistants the repository uses ([1a85905](https://github.com/dannycalleri/turbo-vibe/commit/1a859058a07ec69ffef03dee3349e3794f726e73))

## [1.0.0-rc.2](https://github.com/dannycalleri/turbo-vibe/compare/v1.0.0-rc.1...v1.0.0-rc.2) (2026-10-15)


### Features

* **adopt:** a coding-assistant skill that adapts an existing project to turbo-vibe ([b87c144](https://github.com/dannycalleri/turbo-vibe/commit/b87c144f48378c3d139c7c05e29b788f18bb8e9a))
* **adopt:** the adoption skill maps every kind of the application's own values ([3464642](https://github.com/dannycalleri/turbo-vibe/commit/34646429991e1da58406c972b65bff122956dd4c))
* **adopt:** the adoption skill maps every kind of the application's own values ([bb3e0c5](https://github.com/dannycalleri/turbo-vibe/commit/bb3e0c58fd2683447c36c38ffbd50134dfeb10e1))
* **config:** services declare the names of their own secrets ([89beebc](https://github.com/dannycalleri/turbo-vibe/commit/89beebcea1dff685b0a05176470508117e7121e6))
* **deploy:** build with placeholders, and put each environment's public values into a copy before shipping ([a14d8c6](https://github.com/dannycalleri/turbo-vibe/commit/a14d8c6cc0f3a9ad3dd7e27f49ca741cf278d3bb))
* **deploy:** give each backend its declared secrets, checked before any change ([4387893](https://github.com/dannycalleri/turbo-vibe/commit/4387893734b8d3a0438bacb6035b6050bd9f2f63))
* **deploy:** give each build its own build secrets, and never ship output that holds one ([49e1e5c](https://github.com/dannycalleri/turbo-vibe/commit/49e1e5cda08fb0ed0584ca8594b0ac2675483333))
* **deploy:** the dry run checks the backend's health route locally ([bc3652b](https://github.com/dannycalleri/turbo-vibe/commit/bc3652b02a79308106ca79d44c9513a518b204eb))
* **examples:** the Next.js and Go examples show a public value per environment ([ff6461e](https://github.com/dannycalleri/turbo-vibe/commit/ff6461ea27fc749112e99379c3e685bb3cd60b6a))
* **examples:** the Next.js example declares a secret and shows whether it arrived ([324c139](https://github.com/dannycalleri/turbo-vibe/commit/324c13908a8eedf599b856b70dd517f0b506f060))
* **examples:** the Python example declares a secret and reports whether it arrived ([872436c](https://github.com/dannycalleri/turbo-vibe/commit/872436ce1588f82faac5c344fbe1ccc4f78ec90c))
* **setup:** ask for each declared secret per environment, and name it when missing ([c8d1681](https://github.com/dannycalleri/turbo-vibe/commit/c8d168184b6847e9aaf2ac00aacb6c06a4154db0))
* **setup:** frontends declare public values, which setup stores per environment as variables ([6c34343](https://github.com/dannycalleri/turbo-vibe/commit/6c343437dd9843d193582551976f1f6ff4fec448))
* **setup:** services declare build secrets, which setup stores once as repository secrets ([a990c78](https://github.com/dannycalleri/turbo-vibe/commit/a990c787f0be816d6b1ac7431b21e22758a96a72))
* **vercel:** set a Next.js app's declared secrets on its Vercel project before shipping ([1ce0d47](https://github.com/dannycalleri/turbo-vibe/commit/1ce0d47e20acd44c88c6e64da1d1ca0438ef5a7a))


### Bug Fixes

* **adopt:** what three rounds of adapting real-shaped projects with the skill taught ([425e316](https://github.com/dannycalleri/turbo-vibe/commit/425e316f9d860b9901b471fb49b2939ec3b3e134))
* **adopt:** what three rounds of adapting real-shaped projects with the skill taught ([d10d9a6](https://github.com/dannycalleri/turbo-vibe/commit/d10d9a6d8ec1492c653a3d201c4b2c05333b4775))

## 1.0.0-rc.1 (2026-10-14)


### Features

* **adapters:** Cloudflare adapters, OpenTofu module, and turbo-vibe apply ([b46cadd](https://github.com/dannycalleri/turbo-vibe/commit/b46caddede4b8d369f03aadc09a802e64bbf057d))
* **apply:** apply the shown plan and refuse deletions unless allowed ([cb97e9d](https://github.com/dannycalleri/turbo-vibe/commit/cb97e9dd1225862ddbbe6bccc63f051bd9f723fb))
* **assistant:** guide a person through setup without ever handling a secret ([79896a0](https://github.com/dannycalleri/turbo-vibe/commit/79896a0ddb01d7898123ce59afed167e455ac282))
* **check:** production without reviewers is a warning; the typed confirmation still guards it ([fd18e0b](https://github.com/dannycalleri/turbo-vibe/commit/fd18e0b6af8d8c99b3b580608179a204e951e3a5))
* **check:** Supabase, WorkOS, Vercel and GitHub checks; bootstrap checklist ([8bf878d](https://github.com/dannycalleri/turbo-vibe/commit/8bf878d011174991eecb750805efcb3c459b338a))
* **check:** turbo-vibe check for tools, the state bucket, and Cloudflare ([ce8223b](https://github.com/dannycalleri/turbo-vibe/commit/ce8223bc8865e7e232c9f5632754fb8b0d518d25))
* **ci:** let Deploy to production promote one example or all of them ([ba67a0c](https://github.com/dannycalleri/turbo-vibe/commit/ba67a0c3396432c1a29c369e40b34ce3a9059970))
* **ci:** let Deploy to production promote one example or all of them ([a5c4e55](https://github.com/dannycalleri/turbo-vibe/commit/a5c4e5545472d541197f93b0afa32cc7faca5316))
* **cli:** config schema, validation, and turbo-vibe plan ([2bde877](https://github.com/dannycalleri/turbo-vibe/commit/2bde8776f8a98f276ee6c3f8fa1c14f22cbae9eb))
* **cloudflare:** wait for the container rollout before smoke, and check SIGTERM handling on every pull request ([f57f1f9](https://github.com/dannycalleri/turbo-vibe/commit/f57f1f987defcf01ef98e5adf0bedcf13f4ce88d))
* **cloudflare:** wait for the container rollout before smoke, and check SIGTERM handling on every pull request ([4ff8581](https://github.com/dannycalleri/turbo-vibe/commit/4ff85811f7ed7cc07346ac0bcd48e86a1fbf8f95))
* **compatibility:** generate COMPATIBILITY.md from the pinned versions and live runs ([50d7e46](https://github.com/dannycalleri/turbo-vibe/commit/50d7e4632c62e6c113b6e9e0792394377c739c54))
* **config:** publish the JSON Schema of turbo-vibe.yaml ([a3cb335](https://github.com/dannycalleri/turbo-vibe/commit/a3cb3352a2a286941692810a1782852f0df5872c))
* **config:** read the Supabase organization from SUPABASE_ORGANIZATION when the file leaves it out ([02abf22](https://github.com/dannycalleri/turbo-vibe/commit/02abf22e4f12a0d73b2e04747c8f3e6b75637a8f))
* **config:** read the Supabase organization from SUPABASE_ORGANIZATION when the file leaves it out ([6f088d4](https://github.com/dannycalleri/turbo-vibe/commit/6f088d46c76b66ca6c6b46d0caa02560f84c0495))
* **containers:** route sessions to named instances; Python API example ([bac0e2f](https://github.com/dannycalleri/turbo-vibe/commit/bac0e2f4dd1b00aea1fbc5f07962b5b218ad20f1))
* **database:** find a branch's parent project through the Supabase API instead of reading its state ([e697b5d](https://github.com/dannycalleri/turbo-vibe/commit/e697b5dc23a7700401d7831989004e51c0cde630))
* **deploy:** deploy and smoke through the adapters, with the Go example ([9e02df7](https://github.com/dannycalleri/turbo-vibe/commit/9e02df744c2c7f6bd2ce3ecffb488f1047db69fc))
* **example:** AuthKit sign-in with WorkOS credentials as backend secrets ([f1002df](https://github.com/dannycalleri/turbo-vibe/commit/f1002dfd287304f86aedd56efc26db0dda1de06b))
* **init:** label beta targets; the Vercel adapters are beta ([7c909d5](https://github.com/dannycalleri/turbo-vibe/commit/7c909d5fd583f81523c6135f0789a2399afae017))
* **init:** point turbo-vibe.yaml at the published schema ([b44a70f](https://github.com/dannycalleri/turbo-vibe/commit/b44a70f5a4a3cb7b843af9832f72b85409a52f4a))
* **init:** turbo-vibe init writes the config and both workflows ([1fa01b7](https://github.com/dannycalleri/turbo-vibe/commit/1fa01b76f19f0e7e84e126f1f1a6e4b875b3b515))
* **init:** write coding-assistant guidance that leaves production to a person ([0559831](https://github.com/dannycalleri/turbo-vibe/commit/05598318301ff59509e6717a470ab904577b053c))
* **migrate:** roles and migrations over the Supabase session pooler ([fceff78](https://github.com/dannycalleri/turbo-vibe/commit/fceff78176780368af37bcc40dd4b5999b8f3394))
* **migrate:** runtime connection as a backend secret; the example reads its row ([eed6ef9](https://github.com/dannycalleri/turbo-vibe/commit/eed6ef995da9505df2e9f67e248c3548b59aff17))
* **origins:** Vercel frontends talk to a Cloudflare backend on its own API host ([7fa5886](https://github.com/dannycalleri/turbo-vibe/commit/7fa5886be1d5327647ceea37f12d1e5310805e4d))
* **plan:** plan --env shows what applying would create, change, replace or delete, per service ([371523d](https://github.com/dannycalleri/turbo-vibe/commit/371523d18142f3657b97515a3d1ea20d2e6b91c4))
* previews in their own environment; staging and production accept only main ([b64a307](https://github.com/dannycalleri/turbo-vibe/commit/b64a3072edcb68c46d5144ce7f4ab72fd2727c1a))
* **previews:** preview deploy and remove for a pull request's branch ([47adc1d](https://github.com/dannycalleri/turbo-vibe/commit/47adc1dbb441c678bb77a981819835f1ecd081b5))
* **previews:** run previews in the preview environment, and say what they receive ([c721b6e](https://github.com/dannycalleri/turbo-vibe/commit/c721b6efba81dcd7628cc2f090bc8bda3ff675f8))
* **promote:** build records and promotion of the last passing staging build ([52667a3](https://github.com/dannycalleri/turbo-vibe/commit/52667a31e91008313b9da719efbf0c79c57e1dbb))
* **promote:** Deploy to production asks for the build ID and refuses any other ([6ed52dc](https://github.com/dannycalleri/turbo-vibe/commit/6ed52dc6a2968f556ea6850522d74fb6933a5734))
* **promote:** read build records and archives from staging's bucket, which production never writes ([3d06ba9](https://github.com/dannycalleri/turbo-vibe/commit/3d06ba9d09eb63c66ad4c402b7a89ddc4d9374bc))
* **release:** publish @turbo-vibe/cli with provenance; adoption guide ([f7e31f6](https://github.com/dannycalleri/turbo-vibe/commit/f7e31f6da254b0fc6250b059041a9269f086ed97))
* separate state per environment; production only reads staging's builds ([d9a442a](https://github.com/dannycalleri/turbo-vibe/commit/d9a442a76bf61ca1a83cfe7bf00a0bb1f004dcf9))
* **setup:** --replace asks for a secret again, and any GitHub environment name is set up like staging ([865de5a](https://github.com/dannycalleri/turbo-vibe/commit/865de5a35a8d3b1e343ff7f75aba26081637fc78))
* **setup:** a preview environment of its own, and staging and production limited to main ([9cae706](https://github.com/dannycalleri/turbo-vibe/commit/9cae7064a597e072ea1d28318a15b9c207cc3b94))
* **setup:** ask for each missing secret with hidden input and store it through gh on stdin ([efc85f7](https://github.com/dannycalleri/turbo-vibe/commit/efc85f7003623e07099b4ca47b76a04c22a525ef))
* **setup:** create the GitHub environments, with a required reviewer on production ([1cfb5a7](https://github.com/dannycalleri/turbo-vibe/commit/1cfb5a7ab46b6b3ea04f2612801f7c4527558195))
* **setup:** end with the checks, run on the values stored in this run ([ff0e5c6](https://github.com/dannycalleri/turbo-vibe/commit/ff0e5c6771a6705291f8825304bf76eed0020271))
* **setup:** find or create the Cloudflare zone and state bucket from one bootstrap token ([37d76d8](https://github.com/dannycalleri/turbo-vibe/commit/37d76d8998531c13bebf65a5ed485b0b59c1bc4d))
* **setup:** find the Supabase organization and Vercel team from their tokens, and refuse the other environment's WorkOS key ([41e1044](https://github.com/dannycalleri/turbo-vibe/commit/41e10449d1c4ac585decaed3026d87f8d9cdcae2))
* **setup:** give each environment its own Cloudflare CI token and R2 keys ([f6f795e](https://github.com/dannycalleri/turbo-vibe/commit/f6f795ef4adc1027ad8de14f903a1c878b256f48))
* **setup:** one state bucket and R2 token per environment, and production reads staging's ([064fa0e](https://github.com/dannycalleri/turbo-vibe/commit/064fa0e98ca729d73878337f95a52568111b2081))
* **setup:** setup --list prints the accounts, plans and person steps for the config, and changes nothing ([16ec5f0](https://github.com/dannycalleri/turbo-vibe/commit/16ec5f09fbc71adcb4c6e9d35290c4130a36accb))
* **setup:** setup --list, and assistant guidance that never handles a secret ([a225c2d](https://github.com/dannycalleri/turbo-vibe/commit/a225c2d42df7d95f742d8c58a608738e108098eb))
* **setup:** wait for the person on Workers Paid and R2, then read the state again ([4a25791](https://github.com/dannycalleri/turbo-vibe/commit/4a257913a2fed4659d1af5bc053bcfe5ea8e326a))
* **sign-in:** keep sign-in cookies host-only, so a production session never reaches another host ([d1d0bfc](https://github.com/dannycalleri/turbo-vibe/commit/d1d0bfc37c9b7dc8e4f0d36a02cb7bb381c50f98))
* static frontends on Vercel, with exact cross-origin settings for a Cloudflare API ([0fc9c28](https://github.com/dannycalleri/turbo-vibe/commit/0fc9c282254229b3bb254661e5d662c8514fb2a1))
* **supabase:** database per environment with the Data API disabled ([3754a6d](https://github.com/dannycalleri/turbo-vibe/commit/3754a6d36d9c757997e76dea3034290a2d9d1526))
* **vercel:** Next.js on Vercel, built once with vercel build and promoted as is ([f8bf93e](https://github.com/dannycalleri/turbo-vibe/commit/f8bf93e21b03e7ee8455cd4339dac71fa51e6c64))
* **vercel:** vercel-static frontends deployed from the CI build ([2751cfb](https://github.com/dannycalleri/turbo-vibe/commit/2751cfb2a3ab689b4f7f36d7851e6e2912ec473c))
* **workos:** register each environment's sign-in callback ([ced2116](https://github.com/dannycalleri/turbo-vibe/commit/ced21163db345fb022d9489e15a052aa97627bd4))


### Bug Fixes

* **apply:** keep the saved plan until tofu apply has read it ([277a3bb](https://github.com/dannycalleri/turbo-vibe/commit/277a3bb3ca76f7077ff7446a7cdce90990d513a3))
* **apply:** reconfigure the OpenTofu backend on every init, so another project's cached backend cannot stop it ([76fa346](https://github.com/dannycalleri/turbo-vibe/commit/76fa346691da30191965571355bb3e9539944ebd))
* **apply:** reconfigure the OpenTofu backend on every init; rename the evidence run to live tests ([46e16ee](https://github.com/dannycalleri/turbo-vibe/commit/46e16ee10b2402ae76d42df27bd0ba0c1e57952f))
* **check:** accept account-owned Cloudflare tokens and the API's name for Containers ([cbb97f6](https://github.com/dannycalleri/turbo-vibe/commit/cbb97f683580e2a45d099ba9ebfe846fa2286292))
* **check:** accept account-owned Cloudflare tokens and the API's name for Containers ([dbd19d8](https://github.com/dannycalleri/turbo-vibe/commit/dbd19d85735f063840cd8e5f2817d00477a1348d))
* **check:** require Workers Containers Write, the permission wrangler's container deploy uses ([6cb4313](https://github.com/dannycalleri/turbo-vibe/commit/6cb431342665ea08e9631dcb101b11e5204bca84))
* **ci:** commit the live tests' COMPATIBILITY.md even when a build left other tracked files changed ([2baa3ed](https://github.com/dannycalleri/turbo-vibe/commit/2baa3ed015f99bc3c72f7979a9c477dbd5d24ce9))
* **ci:** commit the live tests' COMPATIBILITY.md even when a build left other tracked files changed ([453ac90](https://github.com/dannycalleri/turbo-vibe/commit/453ac9036c3472b35cdc4e1803c5e77b13dce3b1))
* **cloudflare:** follow the rollout the deploy started by ID, since the application's version lags behind it ([04de6a7](https://github.com/dannycalleri/turbo-vibe/commit/04de6a776151a14efc33b98a27d17a9f2e1946db))
* **cloudflare:** roll a container image out to every instance at once ([71880f9](https://github.com/dannycalleri/turbo-vibe/commit/71880f9e2e9aed511ce18ca0c40bda199fb8fba9))
* **cloudflare:** skip the SIGTERM check when a dry run deploys a recorded image, which must not build ([0c701e8](https://github.com/dannycalleri/turbo-vibe/commit/0c701e855dcc7c1dc5623c6fd2911f6759c2c7ed))
* **examples:** exit the Python API on SIGTERM so a deploy replaces its container at once ([169ca95](https://github.com/dannycalleri/turbo-vibe/commit/169ca956b7bf3f04603e90b04a2386261ac7092f))
* **infra:** give a new Worker placeholder code so its routes can be created before the first deploy ([6cb2e7f](https://github.com/dannycalleri/turbo-vibe/commit/6cb2e7ffecfe34cb036652e895dce64ba951453a))
* let a second staging deploy succeed (Supabase pooler login, container replacement) ([25b8919](https://github.com/dannycalleri/turbo-vibe/commit/25b8919d2f46fc8af0c3539c75cf3065a9e12a38))
* **migrate:** derive the role verifiers' salt from the password so a re-run does not lock roles out of Supabase's pooler ([725f5e5](https://github.com/dannycalleri/turbo-vibe/commit/725f5e57a12ced6d5964fd500759f2d045b7bd07))
* **migrate:** keep each role's SCRAM salt random in OpenTofu state instead of deriving it from the password ([e61ef76](https://github.com/dannycalleri/turbo-vibe/commit/e61ef76a0cf1176e5338f1259de6a255d98ae24a))
* **migrate:** report an unreachable Supabase API in one line ([56fa7c3](https://github.com/dannycalleri/turbo-vibe/commit/56fa7c31ff1dff3d30959b08eca44b216a36917e))
* **migrate:** report an unreachable Supabase API in one line instead of a stack trace ([06e1077](https://github.com/dannycalleri/turbo-vibe/commit/06e10774590f9d9f7db08242a0b6e62e821738a9))
* **preview:** keep a preview's whole hostname within the 64 characters a certificate allows ([2949090](https://github.com/dannycalleri/turbo-vibe/commit/29490905c08f85273e3e75f5468e8cf2ec6d45e8))
* **preview:** link a backend with no page on its hostname to /api/health, not to a root that answers 522 ([dc78290](https://github.com/dannycalleri/turbo-vibe/commit/dc78290dd6b620133a93b9b34d13f93cfa77fe86))
* **preview:** link backends to /api/health instead of a root that answers 522 ([14c32e2](https://github.com/dannycalleri/turbo-vibe/commit/14c32e2503a778c8db5528c8e8b5608dbc5fd9b1))
* **previews:** build and report the pull request's head commit, not the merge with the base branch ([5bb4f4d](https://github.com/dannycalleri/turbo-vibe/commit/5bb4f4d5239dabd3f2da6ce584355de4580c7f1a))
* **previews:** keep preview hostnames off configured hosts and the live tests' preview ([f464022](https://github.com/dannycalleri/turbo-vibe/commit/f4640225e27e4118d0588aea13161e9acc75e552))
* **promote:** refuse a build ID that is not a full commit SHA before using or printing it ([b869faa](https://github.com/dannycalleri/turbo-vibe/commit/b869faaeebd658ca1c9712814ecb3c3184a6dafe))
* **setup:** check the GitHub environment setup configured, not its kind ([2a0e223](https://github.com/dannycalleri/turbo-vibe/commit/2a0e223f87592705f1e68ee87e8da353b2ab8244))
* **setup:** check the GitHub environment setup configured, not its kind ([3cb1d3f](https://github.com/dannycalleri/turbo-vibe/commit/3cb1d3f453b4cecdee6468c70f3a5df2e48fb213))
* **vercel:** build Next.js functions standalone so the shipped output carries its dependencies ([afe957f](https://github.com/dannycalleri/turbo-vibe/commit/afe957fb65da7b5001727cb5cfeeab372faea3d0))
* **vercel:** build Next.js functions standalone so the shipped output carries its dependencies ([907bf70](https://github.com/dannycalleri/turbo-vibe/commit/907bf70c2dd7d9b5c8af01a391a5d130e2b020bb))
* **workflows:** declare SUPABASE_ORGANIZATION in the reusable workflows' secrets ([398fe89](https://github.com/dannycalleri/turbo-vibe/commit/398fe89e9c833dede0890ccd1740c4f3dbb89cdb))
