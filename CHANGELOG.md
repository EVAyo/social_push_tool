# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

# [1.5.0](https://github.com/sparanoid/a-soul/compare/v1.4.0...v1.5.0) (2022-05-14)


### Bug Fixes

* **core:** avoid undefined service request log ([7f16ff6](https://github.com/sparanoid/a-soul/commit/7f16ff6ed3d783c5a814a9e2ae4cf8cfc293addd))
* **core:** douyin-live detection outdated ([16df9d9](https://github.com/sparanoid/a-soul/commit/16df9d993b3236a98150a82dc069537242c38689))
* **core:** wrong bilibili geolocation detection ([06ac1c9](https://github.com/sparanoid/a-soul/commit/06ac1c9eceb9a8e6286f1b3482e75d69c7b16ff3))


### Features

* **core:** ability to check comments for bilibili and weibo ([7e79716](https://github.com/sparanoid/a-soul/commit/7e797169b2a5402ae8b1c100bcda5248436d1902))
* **core:** sending image with multipart/form-data to avoid weird file naming issues ([a53f821](https://github.com/sparanoid/a-soul/commit/a53f82146c62de997409504f361af964e49295d4))
* **core:** telegram channel avatar auto update from bilibili ([b4dc7b0](https://github.com/sparanoid/a-soul/commit/b4dc7b026d3d3ca819449cc1acc3aa86ee30af86))
* **core:** update telegram chat photo when user avatar updates in inincluded sources ([24e84d0](https://github.com/sparanoid/a-soul/commit/24e84d0fca55c7451537ebe60d2e0fec44e01c83))





# [1.4.0](https://github.com/sparanoid/a-soul/compare/v1.3.2...v1.4.0) (2022-05-12)


### Bug Fixes

* **core:** missing `biliId` when checks ddstats ([b532238](https://github.com/sparanoid/a-soul/commit/b5322381f4697f8d0f64e4491b7cbfbd3c6a9261))
* **core:** wrong log scope for ddstats ([17de0c4](https://github.com/sparanoid/a-soul/commit/17de0c4aca98421f067e8d748206a6005e4cb539))
* **core:** wrong tenary concat ([beb35b8](https://github.com/sparanoid/a-soul/commit/beb35b8761b708e1f463c42715a95e2aa2ad8f25))


### Features

* add new arch ([ab7d97c](https://github.com/sparanoid/a-soul/commit/ab7d97c169617d1a1a39b655216a05f5a71a4f3d))
* **core:** ability to check bilibili vip status ([adebe5e](https://github.com/sparanoid/a-soul/commit/adebe5e6d3a676dc475e5c589225c6939210c630))
* **core:** ability to show requesting urls in verbose mode ([bfcc2fb](https://github.com/sparanoid/a-soul/commit/bfcc2fbbcd3b2b120bfd35d763917803fd8c5a47))
* **core:** add telegram sending cache support ([6062677](https://github.com/sparanoid/a-soul/commit/6062677b28f73aa9ec6fe00d1b367bc97f1da5e0))
* **core:** new method to fetch and push more than one activities ([fca1222](https://github.com/sparanoid/a-soul/commit/fca122227a97288e562fef1a92102fc3a71cdc75))
* **core:** new method to fetch and push more than one activities for bilibili ([cf7c33b](https://github.com/sparanoid/a-soul/commit/cf7c33be1a0e61c472e95d9a80c83a6d3bbb3369))
* **core:** new method to fetch and push more than one weibo activities ([0d74654](https://github.com/sparanoid/a-soul/commit/0d746540939c085a6398930a061f7098b01da5fc))
* **core:** refine (disable) deleted weibo detection ([e1b4cf1](https://github.com/sparanoid/a-soul/commit/e1b4cf100f186e74e80e4b1f11aa6d3b47d2d99c))
* **core:** refine ddstats logic ([ee98de7](https://github.com/sparanoid/a-soul/commit/ee98de7eeee831018938723711aabfdad971dc5c))
* **core:** refine ddstats output ([12492b2](https://github.com/sparanoid/a-soul/commit/12492b2e975c7c2275e17daf7f4a2c9a30576d03))
* **core:** send bilibili additional photos in correct order ([cd5614d](https://github.com/sparanoid/a-soul/commit/cd5614d5dbbed278febc459df18485bd71d60ded))
* **core:** send weibo additional photos in correct order ([b10d027](https://github.com/sparanoid/a-soul/commit/b10d0271c28374d1c74c77191458ae25ded9bb9d))
* **core:** show forced geo region for weibo ([557d4c5](https://github.com/sparanoid/a-soul/commit/557d4c5fff07becbc27bdc1b87de9bf099a27f0f))
* **core:** use new magic word for seperate sticky post ([987eefd](https://github.com/sparanoid/a-soul/commit/987eefd229632a6518096f394f7b1ea5e05548cd))
* migrate to normal telegram markup ([ec6ef1b](https://github.com/sparanoid/a-soul/commit/ec6ef1b1a6e686271015142205e97635366e27e9))
* refine error handling ([0ab12de](https://github.com/sparanoid/a-soul/commit/0ab12de26b710206ac662e2d1713b23740bb9d1e))
* try vips-dev for arm/v7 ([6a74727](https://github.com/sparanoid/a-soul/commit/6a74727f4646a260f2878da5856b87142516ab0b))
* update default user agent ([9d26b18](https://github.com/sparanoid/a-soul/commit/9d26b18375c558073ff7c7875f6f2125175edf29))


### Reverts

* Revert "chore: update deps" ([641d926](https://github.com/sparanoid/a-soul/commit/641d926e6cca1f82dbacd2d8708954ea93d5f4c6))
