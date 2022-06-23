# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

## [1.5.2](https://github.com/sparanoid/eop/compare/v1.5.1...v1.5.2) (2022-05-28)


### Bug Fixes

* **core:** missing `bilibiliFollowingBotThrottle` ([00be7be](https://github.com/sparanoid/eop/commit/00be7bebb6249dbe85e95c0448b81c9fe51931e8))
* **core:** missing livestream reteet type for bilibili-mblog ([59ad3da](https://github.com/sparanoid/eop/commit/59ad3dac02c3329ccd69bd69510cb46833a95fc8))
* **core:** missing livestream retweet type for bilibili-mblog ([e08f73b](https://github.com/sparanoid/eop/commit/e08f73baf009d9f9f2eb33ecd2591f530d9f743d))
* **core:** missing request options for ddstats ([9ebb3dd](https://github.com/sparanoid/eop/commit/9ebb3ddf43c5fd2f7c4b5b711256d49640954d86))
* **core:** try fixing outdated comment id ([5505df9](https://github.com/sparanoid/eop/commit/5505df9f9203cd14d53664d6d216f66f1bde2271))
* **core:** try fixing outdated dynamic id ([5cda7b2](https://github.com/sparanoid/eop/commit/5cda7b2ebe08289432199c5b515a98787b1c9206))
* **core:** version unknown in npx package, ref https://github.com/yargs/yargs/issues/1934 ([be51ffb](https://github.com/sparanoid/eop/commit/be51ffb19ca5539f63d4c1a0462d8dc212410dc2))
* **core:** wrong account create time for bilibili following check ([4788cfe](https://github.com/sparanoid/eop/commit/4788cfee2e54d1478361fbfcb2368bfa937c0206))
* **core:** wrong ddstats string parsing ([4061b40](https://github.com/sparanoid/eop/commit/4061b400303945fb18a0a09e201c7302532de105))
* **rss:** not checking item array first before processing ([622d5f2](https://github.com/sparanoid/eop/commit/622d5f281afb63bb7ac0f9285cf25c47fc26cbae))


### Features

* **core:** ability to check room cover for bilibili-live ([3bdfe7b](https://github.com/sparanoid/eop/commit/3bdfe7b1d7570aacdf0b2be1015b83019802b06d))
* **core:** ability to set `tracesSampleRate` for sentry in config ([bed2af5](https://github.com/sparanoid/eop/commit/bed2af5d1c0db9df07c7526d42816478261c3747))
* **core:** add afdian support ([fdeeab6](https://github.com/sparanoid/eop/commit/fdeeab6773064f09f2d5405344b906129b4637c4))
* **core:** add bilibili deprecated api to fetch followings ([104cd95](https://github.com/sparanoid/eop/commit/104cd9533ea5284a61631847f588c8258a818571))
* **core:** add bilibili following check ([b7a0129](https://github.com/sparanoid/eop/commit/b7a012964ba92e706c4dddc4a978943bf8274e84))
* **core:** add bilibili reply user handle support ([b7aee40](https://github.com/sparanoid/eop/commit/b7aee40caf97a0e0341cbb93ce86bd5d0efb2375))
* **core:** add original activity timestamps ([8f46eb4](https://github.com/sparanoid/eop/commit/8f46eb4d95e31c2d2bd4b5159d3f07ce6712cdf1))
* **core:** add replied commet content for bilibili-mblog ([addbdfc](https://github.com/sparanoid/eop/commit/addbdfc3410d22c60cb82d316a829528556f1ce6))
* **core:** add rsshub-json support ([bcd04d9](https://github.com/sparanoid/eop/commit/bcd04d996e19dc34e47e2854f3efa65e452d1442))
* **core:** add sentry support ([def8244](https://github.com/sparanoid/eop/commit/def82444b1b3beb94ffb701004566d8f0ba2c4b9))
* **core:** add tapechat support ([fe7ccc1](https://github.com/sparanoid/eop/commit/fe7ccc1691969d11f8884039d6c0516a0f5a6fab))
* **core:** add weibo reply user handle support ([d2b3eb4](https://github.com/sparanoid/eop/commit/d2b3eb455a2036a6ef4fcada96931c776cfbebef))
* **core:** better comment fetching for bilibili-mblog ([7e5ad8b](https://github.com/sparanoid/eop/commit/7e5ad8b7708348b01a803c4a6ba3a453a0e79ff0))
* **core:** check sticky comments for bilibili-mblog ([3160cd1](https://github.com/sparanoid/eop/commit/3160cd102d62078345108a6b28fd877f30d8b7de))
* **core:** disable notifications for ddstats ([9ef9e0b](https://github.com/sparanoid/eop/commit/9ef9e0b4053149cce2d423fe11fad7e1178ffe87))
* **core:** init support for rss ([93f5fca](https://github.com/sparanoid/eop/commit/93f5fca339dccc29c3d6041853e866af7b0dec91))
* **core:** larger comment cache ([3ca6e7b](https://github.com/sparanoid/eop/commit/3ca6e7b1a4fed377e23cf1bb09d332ce988a676a))
* **core:** refine ddstats output ([334d41a](https://github.com/sparanoid/eop/commit/334d41a16db4bfcafa2c77d4e32c17001a2455f1))
* **core:** refine ddstats output ([86f45c8](https://github.com/sparanoid/eop/commit/86f45c874a0bf6bae422b31c763b4ca5a2b5fb6b))
* **core:** refine fetching comments with `bilibiliFetchCommentsLimit` ([f362c0f](https://github.com/sparanoid/eop/commit/f362c0f9b84363edbc95bfc6f71126aa71802b6c))
* **core:** refine tapechat media output ([e270e57](https://github.com/sparanoid/eop/commit/e270e57901538f9d53092fcea20f915eb02e8d05))
* **core:** remove the use of `cache` directory for `processImage` ([76ba72d](https://github.com/sparanoid/eop/commit/76ba72d9848cffcbbd734092dbe71b72b83d586a))
* **core:** replace weibo custom emojis with its alt attribute ([44daac9](https://github.com/sparanoid/eop/commit/44daac9eee8dfb843cc4b442da8a91f022fce937))
* **core:** retry failed video weibo with plain text ([a6db951](https://github.com/sparanoid/eop/commit/a6db9510a17b28cde05188273a00df72e3534927))
* **core:** use docker built-in init program to handle signals ([48c14fc](https://github.com/sparanoid/eop/commit/48c14fc9af3287f12971602c59444043cca6b444))
* **core:** use form to send new video/video retweet for bilibili-mblog ([e574e13](https://github.com/sparanoid/eop/commit/e574e13a6f46cd13b57d309b942cca78cfd18010))
* **core:** use v2 api for bilibili-live ([25e7658](https://github.com/sparanoid/eop/commit/25e765804fbd8d4ecfb9f2b00ee65217c8e19ada))
* **extractor-rss:** init project ([182c672](https://github.com/sparanoid/eop/commit/182c67258701873ecafb0df3c87a020d8aec0eee))
* update config name ([55970a6](https://github.com/sparanoid/eop/commit/55970a60b3e27f4cf33ff2c7455e937d32fc80fc))


### BREAKING CHANGES

* the original option will not work





## [1.5.1](https://github.com/sparanoid/eop/compare/v1.5.0...v1.5.1) (2022-05-14)


### Bug Fixes

* **core:** wrong comment fetching for bilibili-mblog ([1561fdc](https://github.com/sparanoid/eop/commit/1561fdcdc0b0ad0b2794e3745d04d64ed3d376a2))


### Features

* **core:** silent comments and reply notifications for telegram by default ([fbfaac7](https://github.com/sparanoid/eop/commit/fbfaac75a9fc57c7137fa544046022addeb7c227))





# [1.5.0](https://github.com/sparanoid/eop/compare/v1.4.0...v1.5.0) (2022-05-14)


### Bug Fixes

* **core:** avoid undefined service request log ([7f16ff6](https://github.com/sparanoid/eop/commit/7f16ff6ed3d783c5a814a9e2ae4cf8cfc293addd))
* **core:** douyin-live detection outdated ([16df9d9](https://github.com/sparanoid/eop/commit/16df9d993b3236a98150a82dc069537242c38689))
* **core:** wrong bilibili geolocation detection ([06ac1c9](https://github.com/sparanoid/eop/commit/06ac1c9eceb9a8e6286f1b3482e75d69c7b16ff3))


### Features

* **core:** ability to check comments for bilibili and weibo ([7e79716](https://github.com/sparanoid/eop/commit/7e797169b2a5402ae8b1c100bcda5248436d1902))
* **core:** sending image with multipart/form-data to avoid weird file naming issues ([a53f821](https://github.com/sparanoid/eop/commit/a53f82146c62de997409504f361af964e49295d4))
* **core:** telegram channel avatar auto update from bilibili ([b4dc7b0](https://github.com/sparanoid/eop/commit/b4dc7b026d3d3ca819449cc1acc3aa86ee30af86))
* **core:** update telegram chat photo when user avatar updates in inincluded sources ([24e84d0](https://github.com/sparanoid/eop/commit/24e84d0fca55c7451537ebe60d2e0fec44e01c83))





# [1.4.0](https://github.com/sparanoid/eop/compare/v1.3.2...v1.4.0) (2022-05-12)


### Bug Fixes

* **core:** missing `biliId` when checks ddstats ([b532238](https://github.com/sparanoid/eop/commit/b5322381f4697f8d0f64e4491b7cbfbd3c6a9261))
* **core:** wrong log scope for ddstats ([17de0c4](https://github.com/sparanoid/eop/commit/17de0c4aca98421f067e8d748206a6005e4cb539))
* **core:** wrong tenary concat ([beb35b8](https://github.com/sparanoid/eop/commit/beb35b8761b708e1f463c42715a95e2aa2ad8f25))


### Features

* add new arch ([ab7d97c](https://github.com/sparanoid/eop/commit/ab7d97c169617d1a1a39b655216a05f5a71a4f3d))
* **core:** ability to check bilibili vip status ([adebe5e](https://github.com/sparanoid/eop/commit/adebe5e6d3a676dc475e5c589225c6939210c630))
* **core:** ability to show requesting urls in verbose mode ([bfcc2fb](https://github.com/sparanoid/eop/commit/bfcc2fbbcd3b2b120bfd35d763917803fd8c5a47))
* **core:** add telegram sending cache support ([6062677](https://github.com/sparanoid/eop/commit/6062677b28f73aa9ec6fe00d1b367bc97f1da5e0))
* **core:** new method to fetch and push more than one activities ([fca1222](https://github.com/sparanoid/eop/commit/fca122227a97288e562fef1a92102fc3a71cdc75))
* **core:** new method to fetch and push more than one activities for bilibili ([cf7c33b](https://github.com/sparanoid/eop/commit/cf7c33be1a0e61c472e95d9a80c83a6d3bbb3369))
* **core:** new method to fetch and push more than one weibo activities ([0d74654](https://github.com/sparanoid/eop/commit/0d746540939c085a6398930a061f7098b01da5fc))
* **core:** refine (disable) deleted weibo detection ([e1b4cf1](https://github.com/sparanoid/eop/commit/e1b4cf100f186e74e80e4b1f11aa6d3b47d2d99c))
* **core:** refine ddstats logic ([ee98de7](https://github.com/sparanoid/eop/commit/ee98de7eeee831018938723711aabfdad971dc5c))
* **core:** refine ddstats output ([12492b2](https://github.com/sparanoid/eop/commit/12492b2e975c7c2275e17daf7f4a2c9a30576d03))
* **core:** send bilibili additional photos in correct order ([cd5614d](https://github.com/sparanoid/eop/commit/cd5614d5dbbed278febc459df18485bd71d60ded))
* **core:** send weibo additional photos in correct order ([b10d027](https://github.com/sparanoid/eop/commit/b10d0271c28374d1c74c77191458ae25ded9bb9d))
* **core:** show forced geo region for weibo ([557d4c5](https://github.com/sparanoid/eop/commit/557d4c5fff07becbc27bdc1b87de9bf099a27f0f))
* **core:** use new magic word for seperate sticky post ([987eefd](https://github.com/sparanoid/eop/commit/987eefd229632a6518096f394f7b1ea5e05548cd))
* migrate to normal telegram markup ([ec6ef1b](https://github.com/sparanoid/eop/commit/ec6ef1b1a6e686271015142205e97635366e27e9))
* refine error handling ([0ab12de](https://github.com/sparanoid/eop/commit/0ab12de26b710206ac662e2d1713b23740bb9d1e))
* try vips-dev for arm/v7 ([6a74727](https://github.com/sparanoid/eop/commit/6a74727f4646a260f2878da5856b87142516ab0b))
* update default user agent ([9d26b18](https://github.com/sparanoid/eop/commit/9d26b18375c558073ff7c7875f6f2125175edf29))


### Reverts

* Revert "chore: update deps" ([641d926](https://github.com/sparanoid/eop/commit/641d926e6cca1f82dbacd2d8708954ea93d5f4c6))
