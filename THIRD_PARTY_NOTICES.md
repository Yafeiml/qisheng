# 第三方组件与素材声明

本项目原创部分采用 Apache License 2.0。第三方组件继续适用各自许可证；根目录 LICENSE 不替代第三方的版权、许可及归属。

本清单基于首版 pnpm 安装树的许可元数据，版本以 pnpm-lock.yaml 为准。源码仓库不包含 node_modules 或官方容器镜像，下面的元数据也不代表已经完成所有 Linux 系统包的二进制再分发审查。后续分发容器、字体或原生二进制时，应保留其内附许可和 NOTICE，并另行核查系统包及 sharp/libvips 等组件。

## 特别说明

- Noto Sans SC 来自 @fontsource-variable/noto-sans-sc，适用 OFL-1.1；完整声明见 [字体许可](third-party-licenses/noto-sans-sc-OFL-1.1.txt)。项目未修改或另行销售字体文件。
- caniuse-lite 的兼容性数据适用 CC-BY-4.0，保留其[许可及原始归属](third-party-licenses/caniuse-lite-CC-BY-4.0.txt)，来源为 https://github.com/browserslist/caniuse-lite 。
- duck 的包元数据标注 BSD，[随包原文](third-party-licenses/duck-BSD.txt)为准。
- jszip 提供 MIT 或 GPL-3.0-or-later 的许可选择；本项目依照其 MIT 选项使用，保留原始声明。
- 员工小程序生成目录内的 [noble-hashes 许可](apps/employee-miniapp/utils/generated/LICENSE.noble-hashes)保持不变。
- 默认 platform-mark.svg 与 medical-examples/layout-example.svg 是本轮从零编写的几何 SVG，依项目 Apache-2.0 授权。原来源不明的医疗示例 PNG 已移除。
- docs/images 中的截图来自真实页面与虚构演示数据，仅展示功能；不包含真实客户、账号、业务结果或外部图片。截图不提供小红书商标授权或官方背书。

## 安装树组件清单

| 组件 | 版本 | 元数据许可证 |
| --- | --- | --- |
| @alicloud/credentials | 2.4.7 | MIT |
| @alicloud/darabonba-array | 0.1.2 | ISC |
| @alicloud/darabonba-encode-util | 0.0.1, 0.0.2 | ISC |
| @alicloud/darabonba-map | 0.0.1 | ISC |
| @alicloud/darabonba-signature-util | 0.0.4 | ISC |
| @alicloud/darabonba-string | 1.0.3 | Apache-2.0 |
| @alicloud/dysmsapi20170525 | 4.6.0 | Apache-2.0 |
| @alicloud/endpoint-util | 0.0.1 | Apache-2.0 |
| @alicloud/gateway-pop | 0.0.6 | ISC |
| @alicloud/gateway-spi | 0.0.8 | ISC |
| @alicloud/openapi-core | 1.0.8 | ISC |
| @alicloud/openapi-util | 0.3.3 | ISC |
| @alicloud/tea-typescript | 1.8.0 | ISC |
| @alicloud/tea-util | 1.4.11 | Apache-2.0 |
| @aws-sdk/checksums | 3.1001.1 | Apache-2.0 |
| @aws-sdk/client-s3 | 3.1141.0 | Apache-2.0 |
| @aws-sdk/core | 3.978.1 | Apache-2.0 |
| @aws-sdk/credential-provider-env | 3.972.72 | Apache-2.0 |
| @aws-sdk/credential-provider-http | 3.972.74 | Apache-2.0 |
| @aws-sdk/credential-provider-ini | 3.973.17 | Apache-2.0 |
| @aws-sdk/credential-provider-login | 3.972.79 | Apache-2.0 |
| @aws-sdk/credential-provider-node | 3.972.84 | Apache-2.0 |
| @aws-sdk/credential-provider-process | 3.972.72 | Apache-2.0 |
| @aws-sdk/credential-provider-sso | 3.973.16 | Apache-2.0 |
| @aws-sdk/credential-provider-web-identity | 3.972.78 | Apache-2.0 |
| @aws-sdk/middleware-sdk-s3 | 3.972.77 | Apache-2.0 |
| @aws-sdk/nested-clients | 3.997.46 | Apache-2.0 |
| @aws-sdk/s3-request-presigner | 3.1141.0 | Apache-2.0 |
| @aws-sdk/signature-v4-multi-region | 3.996.47 | Apache-2.0 |
| @aws-sdk/token-providers | 3.1138.0 | Apache-2.0 |
| @aws-sdk/types | 3.974.6 | Apache-2.0 |
| @aws-sdk/xml-builder | 3.972.41 | Apache-2.0 |
| @aws/lambda-invoke-store | 0.3.0 | Apache-2.0 |
| @borewit/text-codec | 0.2.2 | MIT |
| @darabonba/typescript | 1.0.5 | Apache License 2.0 |
| @exodus/bytes | 1.16.0 | MIT |
| @fontsource-variable/noto-sans-sc | 5.3.0 | OFL-1.1 |
| @img/colour | 1.1.0 | MIT |
| @ioredis/commands | 2.0.0 | MIT |
| @lukeed/csprng | 1.1.0 | MIT |
| @microsoft/tsdoc | 0.17.0 | MIT |
| @napi-rs/canvas | 0.1.80 | MIT |
| @nestjs/common | 12.1.0 | MIT |
| @nestjs/core | 12.1.0 | MIT |
| @nestjs/mapped-types | 12.0.0 | MIT |
| @nestjs/platform-express | 12.1.0 | MIT |
| @nestjs/swagger | 12.0.2 | MIT |
| @next/env | 16.3.6 | MIT |
| @noble/hashes | 2.4.0 | MIT |
| @nodable/entities | 3.0.0 | MIT |
| @prisma/adapter-pg | 7.10.0 | Apache-2.0 |
| @prisma/client | 7.10.0 | Apache-2.0 |
| @prisma/client-runtime-utils | 7.10.0 | Apache-2.0 |
| @prisma/debug | 7.10.0 | Apache-2.0 |
| @prisma/driver-adapter-utils | 7.10.0 | Apache-2.0 |
| @scarf/scarf | 1.4.0 | Apache-2.0 |
| @smithy/core | 3.33.3, 3.35.0 | Apache-2.0 |
| @smithy/credential-provider-imds | 4.5.2 | Apache-2.0 |
| @smithy/fetch-http-handler | 5.8.0 | Apache-2.0 |
| @smithy/node-http-handler | 4.12.1 | Apache-2.0 |
| @smithy/signature-v4 | 5.7.3 | Apache-2.0 |
| @smithy/types | 4.17.2, 4.19.0 | Apache-2.0 |
| @standard-schema/spec | 1.1.0 | MIT |
| @swc/helpers | 0.5.23 | Apache-2.0 |
| @tokenizer/inflate | 0.4.1 | MIT |
| @tokenizer/token | 0.3.0 | MIT |
| @tootallnate/once | 2.0.1 | MIT |
| @types/node | 12.20.55, 20.19.43, 22.20.1 | MIT |
| @types/pg | 8.23.1 | MIT |
| @types/validator | 13.15.10 | MIT |
| @vant/area-data | 2.2.0 | MIT |
| @wecom/crypto | 1.0.1 | MIT |
| @xmldom/xmldom | 0.8.15 | MIT |
| accepts | 2.0.0 | MIT |
| agent-base | 6.0.2 | MIT |
| anynum | 1.0.1 | MIT |
| append-field | 1.0.0 | MIT |
| argparse | 1.0.10 | MIT |
| argparse | 2.0.1 | Python-2.0 |
| base64-js | 1.5.1 | MIT |
| baseline-browser-mapping | 2.11.19 | Apache-2.0 |
| body-parser | 2.3.0 | MIT |
| boolbase | 1.0.0 | ISC |
| bowser | 2.14.1 | MIT |
| buffer-equal-constant-time | 1.0.1 | BSD-3-Clause |
| bullmq | 6.3.9 | MIT |
| busboy | 1.6.0 | MIT |
| bytes | 3.1.2 | MIT |
| call-bind-apply-helpers | 1.0.2 | MIT |
| call-bound | 1.0.4 | MIT |
| caniuse-lite | 1.0.30001810 | CC-BY-4.0 |
| cheerio | 1.2.0 | MIT |
| cheerio-select | 2.1.0 | BSD-2-Clause |
| class-transformer | 0.5.1 | MIT |
| class-validator | 0.15.1 | MIT |
| client-only | 0.0.1 | MIT |
| cluster-key-slot | 1.1.1 | Apache-2.0 |
| content-disposition | 1.1.0 | MIT |
| content-type | 1.0.5, 2.1.0 | MIT |
| cookie | 0.7.2 | MIT |
| cookie-signature | 1.2.2 | MIT |
| core-util-is | 1.0.3 | MIT |
| cors | 2.8.6 | MIT |
| cron-parser | 5.10.1 | MIT |
| css-select | 5.2.2 | BSD-2-Clause |
| css-what | 6.2.2 | BSD-2-Clause |
| debug | 4.4.3 | MIT |
| denque | 2.1.0 | Apache-2.0 |
| depd | 2.0.0 | MIT |
| detect-libc | 2.1.2 | Apache-2.0 |
| dingbat-to-unicode | 1.0.1 | BSD-2-Clause |
| dom-serializer | 2.0.0 | MIT |
| domelementtype | 2.3.0 | BSD-2-Clause |
| domhandler | 5.0.3 | BSD-2-Clause |
| domutils | 3.2.2 | BSD-2-Clause |
| duck | 0.1.12 | BSD |
| dunder-proto | 1.0.1 | MIT |
| ecdsa-sig-formatter | 1.0.11 | Apache-2.0 |
| ee-first | 1.1.1 | MIT |
| encodeurl | 2.0.0 | MIT |
| encoding-sniffer | 1.0.2 | MIT |
| entities | 4.5.0, 6.0.1, 7.0.1 | BSD-2-Clause |
| es-define-property | 1.0.1 | MIT |
| es-errors | 1.3.0 | MIT |
| es-object-atoms | 1.1.2 | MIT |
| es-toolkit | 1.52.0 | MIT |
| escape-html | 1.0.3 | MIT |
| etag | 1.8.1 | MIT |
| express | 5.2.1 | MIT |
| fast-safe-stringify | 2.1.1 | MIT |
| fast-xml-builder | 1.3.1 | MIT |
| fast-xml-parser | 5.11.1 | MIT |
| file-type | 22.1.1 | MIT |
| finalhandler | 2.1.1 | MIT |
| forwarded | 0.2.0 | MIT |
| fresh | 2.0.0 | MIT |
| function-bind | 1.1.2 | MIT |
| get-intrinsic | 1.3.0 | MIT |
| get-proto | 1.0.1 | MIT |
| gopd | 1.2.0 | MIT |
| has-symbols | 1.1.0 | MIT |
| hasown | 2.0.4 | MIT |
| htmlparser2 | 10.1.0 | MIT |
| http-errors | 2.0.1 | MIT |
| http-proxy-agent | 5.0.0 | MIT |
| https-proxy-agent | 5.0.1 | MIT |
| httpx | 2.3.3 | MIT |
| iconv-lite | 0.7.3 | MIT |
| ieee754 | 1.2.1 | BSD-3-Clause |
| immediate | 3.0.6 | MIT |
| inherits | 2.0.4 | ISC |
| ini | 1.3.8 | ISC |
| ioredis | 6.0.0 | MIT |
| ip-address | 10.7.0 | MIT |
| ipaddr.js | 1.9.1 | MIT |
| is-promise | 4.0.0 | MIT |
| is-unsafe | 2.0.2 | MIT |
| isarray | 1.0.0 | MIT |
| iterare | 1.2.1 | ISC |
| js-yaml | 5.4.2 | MIT |
| jsonwebtoken | 9.0.3 | MIT |
| jszip | 3.10.1 | (MIT OR GPL-3.0-or-later) |
| jwa | 2.0.1 | MIT |
| jws | 4.0.1 | MIT |
| kitx | 2.2.0 | MIT |
| libphonenumber-js | 1.13.12 | MIT |
| lie | 3.3.0 | MIT |
| load-esm | 1.0.3 | MIT |
| lodash | 4.18.1 | MIT |
| lodash.includes | 4.3.0 | MIT |
| lodash.isboolean | 3.0.3 | MIT |
| lodash.isinteger | 4.0.4 | MIT |
| lodash.isnumber | 3.0.3 | MIT |
| lodash.isplainobject | 4.0.6 | MIT |
| lodash.isstring | 4.0.1 | MIT |
| lodash.once | 4.1.1 | MIT |
| lop | 0.4.2 | BSD-2-Clause |
| luxon | 3.7.2 | MIT |
| mammoth | 1.13.0 | BSD-2-Clause |
| math-intrinsics | 1.1.0 | MIT |
| media-typer | 0.3.0, 1.1.1 | MIT |
| merge-descriptors | 2.0.0 | MIT |
| mime-db | 1.52.0, 1.54.0 | MIT |
| mime-types | 2.1.35, 3.0.2 | MIT |
| moment | 2.30.1 | MIT |
| moment-timezone | 0.5.48 | MIT |
| ms | 2.1.3 | MIT |
| msgpackr | 2.1.0 | MIT |
| multer | 2.4.0 | MIT |
| nanoid | 3.3.18 | MIT |
| negotiator | 1.1.0 | MIT |
| next | 16.3.6 | MIT |
| node-abort-controller | 3.1.1 | MIT |
| nodemailer | 10.0.10 | MIT-0 |
| nth-check | 2.1.1 | BSD-2-Clause |
| object-assign | 4.1.1 | MIT |
| object-inspect | 1.13.4 | MIT |
| on-finished | 2.4.1 | MIT |
| once | 1.4.0 | ISC |
| option | 0.2.4 | BSD-2-Clause |
| pako | 1.0.11 | (MIT AND Zlib) |
| parse5 | 7.3.0 | MIT |
| parse5-htmlparser2-tree-adapter | 7.1.0 | MIT |
| parse5-parser-stream | 7.1.2 | MIT |
| parseurl | 1.3.3 | MIT |
| path-expression-matcher | 1.6.2 | MIT |
| path-to-regexp | 8.4.2 | MIT |
| pdf-parse | 2.4.5 | Apache-2.0 |
| pdfjs-dist | 5.4.296 | Apache-2.0 |
| pg | 8.23.0 | MIT |
| pg-connection-string | 2.14.0 | MIT |
| pg-int8 | 1.0.1 | ISC |
| pg-pool | 3.14.0 | MIT |
| pg-protocol | 1.16.0 | MIT |
| pg-types | 2.2.0 | MIT |
| pgpass | 1.0.5 | MIT |
| picocolors | 1.1.1 | ISC |
| playwright-core | 1.63.0 | Apache-2.0 |
| postcss | 8.5.23 | MIT |
| postgres-array | 2.0.0, 3.0.4 | MIT |
| postgres-bytea | 1.0.1 | MIT |
| postgres-date | 1.0.7 | MIT |
| postgres-interval | 1.2.0 | MIT |
| process-nextick-args | 2.0.1 | MIT |
| proxy-addr | 2.0.7 | MIT |
| qs | 6.16.0 | BSD-3-Clause |
| range-parser | 1.3.0 | MIT |
| raw-body | 3.0.2 | MIT |
| react | 19.3.0 | MIT |
| react-dom | 19.3.0 | MIT |
| readable-stream | 2.3.8 | MIT |
| redis-errors | 1.2.0 | MIT |
| reflect-metadata | 0.2.2 | Apache-2.0 |
| router | 2.2.0 | MIT |
| rxjs | 7.8.2 | Apache-2.0 |
| safe-buffer | 5.1.2, 5.2.1 | MIT |
| safer-buffer | 2.1.2 | MIT |
| sax | 1.6.1 | BlueOak-1.0.0 |
| scheduler | 0.28.0 | MIT |
| semver | 7.8.5 | ISC |
| send | 1.2.1 | MIT |
| serve-static | 2.2.1 | MIT |
| setimmediate | 1.0.5 | MIT |
| setprototypeof | 1.2.0 | ISC |
| sharp | 0.35.4 | Apache-2.0 |
| side-channel | 1.1.1 | MIT |
| side-channel-list | 1.0.1 | MIT |
| side-channel-map | 1.0.1 | MIT |
| side-channel-weakmap | 1.0.2 | MIT |
| sm3 | 1.0.3 | MIT |
| smart-buffer | 4.2.0 | MIT |
| socks | 2.8.10 | MIT |
| socks-proxy-agent | 6.2.1 | MIT |
| source-map-js | 1.2.1 | BSD-3-Clause |
| split2 | 4.2.0 | ISC |
| sprintf-js | 1.0.3 | BSD-3-Clause |
| standard-as-callback | 2.1.0 | MIT |
| statuses | 2.0.2 | MIT |
| streamsearch | 1.1.0 | MIT |
| string_decoder | 1.1.1 | MIT |
| strnum | 2.4.2 | MIT |
| strtok3 | 10.3.5 | MIT |
| styled-jsx | 5.1.6 | MIT |
| swagger-ui-dist | 5.33.0 | Apache-2.0 |
| toidentifier | 1.0.1 | MIT |
| token-types | 6.1.2 | MIT |
| tslib | 2.8.1 | 0BSD |
| type-is | 1.6.18, 2.1.0 | MIT |
| uid | 2.0.2 | MIT |
| uint8array-extras | 1.5.0 | MIT |
| underscore | 1.13.8 | MIT |
| undici | 7.29.0, 8.11.2 | MIT |
| undici-types | 6.21.0 | MIT |
| unpipe | 1.0.0 | MIT |
| util-deprecate | 1.0.2 | MIT |
| validator | 13.15.35 | MIT |
| vary | 1.1.2 | MIT |
| whatwg-mimetype | 4.0.0 | MIT |
| wrappy | 1.0.2 | ISC |
| ws | 8.21.3 | MIT |
| xml-naming | 0.3.0 | MIT |
| xml2js | 0.6.2 | MIT |
| xmlbuilder | 10.1.1, 11.0.1 | MIT |
| xtend | 4.0.2 | MIT |
