export type GenerationStylePreset = {
  id: string;
  name: string;
  description: string;
  prompt: string;
  enabled: boolean;
  isDefault: boolean;
};

export type GenerationStyleConfiguration = {
  copyBasePrompt: string;
  imageBasePrompt: string;
  contentDirections: GenerationStylePreset[];
  imageStyles: GenerationStylePreset[];
};

export type GenerationStyleSnapshot = {
  schemaVersion: 1;
  configurationVersion: number;
  copyBasePrompt: string;
  imageBasePrompt: string;
  contentDirection: Pick<GenerationStylePreset, "id" | "name" | "prompt">;
  imageStyle: Pick<GenerationStylePreset, "id" | "name" | "prompt">;
};

// Keep historical built-ins exact to recognize unchanged defaults without replacing custom rules.
function legacyGenerationStyles(): GenerationStyleConfiguration {
  const preset = (
    id: string,
    name: string,
    description: string,
    prompt: string,
    isDefault = false,
  ): GenerationStylePreset => ({ id, name, description, prompt, enabled: true, isDefault });
  return {
    copyBasePrompt:
      "采用自然、具体的小红书表达。标题突出一个清晰的信息点，开头从读者真实关心的问题切入。正文用短段落，每段只讲一个重点；必要时少量使用 Emoji 和列表。避免广告腔、夸张堆词、重复感叹号及生硬引导。只依据授权资料表达，不编造亲身体验、患者故事、效果、价格或资质。结尾给出与正文相关的实用建议，话题标签简洁且准确。",
    imageBasePrompt:
      "生成精致、自然且主题明确的竖版配图。主体突出，构图有层次，光线柔和，色彩协调，材质与细节可信，背景简洁，避免元素堆砌、过度锐化、塑料质感和不自然的人体结构。重要主体置于安全裁切区，统一一组图片的视觉气质。严格保持所选视觉风格，不在摄影与插画之间自行切换。",
    contentDirections: [
      preset(
        "direction-education",
        "专业科普",
        "用易懂的表达说明原理、适用条件与注意事项。",
        "以专业科普为内容方向，围绕一个核心问题解释原理、适用条件及注意事项。专业术语第一次出现时用日常语言解释，保留必要的限制条件，不把科普写成效果承诺。",
        true,
      ),
      preset(
        "direction-questions",
        "常见问题解答",
        "从读者关心的问题出发，逐项给出清楚回答。",
        "以常见问题解答为内容方向。选取与本次主题最相关的读者问题，用提问与简短回答组织内容。优先解答决策前需要知道的信息，区分已知事实与需要进一步咨询的情况。",
      ),
      preset(
        "direction-project",
        "项目与技术介绍",
        "介绍项目特点、技术信息及服务流程。",
        "以项目与技术介绍为内容方向，突出授权资料中有依据的特点，结合流程解释其实际意义。每个卖点都对应具体事实，避免空泛的先进、领先和绝对化比较。",
      ),
    ],
    imageStyles: [
      preset(
        "image-documentary",
        "真实场景摄影",
        "自然光影、真实空间与克制的纪实构图。",
        "采用真实场景摄影风格，以本次活动相关的专业空间、设备或自然交流为主体。自然柔和光线，真实材质与透视，克制的色彩和景深。画面具有纪实摄影质感，不使用插画、卡通或 3D 渲染风格，不将虚构人物表现为指定的真实专家。",
        true,
      ),
      preset(
        "image-minimal",
        "简约静物摄影",
        "简洁背景、精致材质与清晰的视觉焦点。",
        "采用简约静物摄影风格，以主题相关的物件、器材或空间细节为主体。使用低饱和背景、柔和侧光和适度留白，重视材质、轮廓与视觉秩序。不出现人物，不切换为插画或卡通。",
      ),
      preset(
        "image-illustration",
        "科技感插画",
        "用克制的插画和抽象元素表达技术主题。",
        "采用精致的科技感编辑插画，以简洁的几何形态、抽象技术元素和柔和立体层次表达本期主题。配色协调，画面轻盈有留白，不伪装成真实诊疗照片，不绘制流程图或带文字的信息图。",
      ),
    ],
  };
}

function researchedGenerationStyles(): GenerationStyleConfiguration {
  const legacy = legacyGenerationStyles();
  const contentPrompts: Record<string, string> = {
    "direction-education":
      "文案基础要求及活动明确的口吻、篇幅和表情限制优先，以下只作默认表达建议：以轻松、有用的科普分享为内容方向，像帮朋友做功课。围绕读者的一个真实疑问，用日常语言解释原理，再给两三个有依据的选择或准备建议；术语随用随解释，不写教科书式长文。用短段、空行和语义 Emoji 标记重点，保留适用条件与个体差异，不把知识解释写成医疗效果承诺。",
    "direction-questions":
      "文案基础要求及活动明确的口吻、篇幅和表情限制优先，以下只作默认表达建议：以朋友聊天式的常见问题解答为内容方向。只挑两三个与本次主题最相关、读者真的会问的问题，每个问题用一两句直接回答，问题之间空一行，可用 🔍、💡、📌 标记。表达亲切、具体，少铺垫、不写长篇问答；区分已知事实与需要专业评估的情况，不虚构用户提问、真实咨询记录或亲身体验。",
    "direction-project":
      "文案基础要求及活动明确的口吻、篇幅和表情限制优先，以下只作默认表达建议：以做功课、看亮点的项目与技术分享为内容方向。从一个日常需求切入，挑两三个授权资料支持的特点，用“具体是什么 → 对了解或选择有什么帮助”解释其实际价值；依据已知流程给实用准备建议。短句分段、轻松种草，少用技术堆词，不写发布会或产品说明书；不虚构体验、口碑、价格、稀缺优惠、资质或功效。",
  };
  const imagePrompts: Record<string, string> = {
    "image-documentary":
      "采用自然场景摄影式的小红书笔记封面，以授权人物、真实设备、专业空间或主题相关的自然交流为主视觉。自然柔和光线，真实肤色、材质和透视，适度景深与生活细节，温暖、干净、有亲近感，避免僵硬宣传照、塑料皮肤和过度修图。可以配简洁短标题及少量标注，摄影主体保持真实；不切换为插画、卡通或 3D，不把虚构人物或场景声称为指定专家、患者案例或真实机构实拍。",
    "image-minimal":
      "采用适合小红书分享的简约静物摄影，以主题相关的物件、器材或空间细节为一个核心主体。低饱和且与品牌协调的背景、柔和侧光、真实材质和轮廓，留白清楚；用可读短标题和一处轻量标注形成视觉重点，避免样板间式奢华、道具堆砌和大促标签。不出现人物，不切换为插画或卡通，不虚构医疗设备结构。",
    "image-illustration":
      "采用亲和、轻盈的科技感编辑插画，以简洁几何形态、抽象技术元素和柔和层次表达一个清晰主题。使用协调的两三种主色、少量图形装饰和充足留白，让专业信息易懂、有温度；不采用冰冷发布会背景、密集仪表盘或霓虹特效。不伪装成诊疗实拍，不制造未经资料支持的解剖结构、流程图、检测结果或带长段文字的信息图。",
  };
  return {
    ...legacy,
    copyBasePrompt: [
      "采用小红书式的轻松分享与有依据的种草口吻，像帮朋友做功课：亲切、具体、有生活感，表达产品或服务为什么值得了解、适合什么场景，少写严肃说明书、官方通稿和空泛广告。平台与活动明确要求的正式语气优先，专业内容保持可信。",
      "标题围绕一个人群、场景或真实看点，尽量控制在 20 个字符内，使用 0–1 个相关 Emoji；不照搬活动任务标题，不用猎奇、恐吓、虚假悬念或效果保证。开头用一句具体场景、疑问或实用结论切入，不写冗长自我介绍。",
      "正文通常以 180–320 字为目标（不含话题标签），素材少时可以更短，不凑字数；必要的专业条件、风险或准备事项不能为缩短篇幅而删除。只挑两三个有事实依据的看点或建议，说明它是什么、与读者有什么关系；每段一个重点、一两句短句，约 3–5 段，段间空一行，要点可各占一行。不机械逐句拆行，不输出 Markdown 标题、粗体或长段资料。",
      "正文积极使用有语义的 Unicode Emoji 帮助分段、标记重点和传达轻松语气，通常约 4–8 个、重点段一两个，例如 ✨、🌿、🔍、💡、📌、📝、✅；短文相应减少。医疗风险与注意事项用清楚平实的提醒，不用兴奋表情淡化风险。不连续堆一串表情、不每句话插表情、不输出 [种草R] 等平台私有表情占位符。JSON 中的正文换行用 \\n 转义。",
      "可按语境少量使用“做功课”“划重点”“一篇说清”“先别急”“其实”“这点挺实用”“可以先看看”等自然表达，每篇选择合适的零到两个，不强塞同一套热词或称呼。不套用“姐妹们”“救命”“绝绝子”“闭眼冲”，不用“天花板”“零风险”“亲测有效”“一次见效”等夸张或承诺话术；句式、开场和重点顺序应随主题自然变化。",
      "只依据授权资料表达事实。没有输入明确支持时，不编造“我用了/我做了”“同事都来问”、患者故事、专家身份、用户评价、疗效、价格或资质。医疗和专业服务种草侧重了解、准备、选择依据，不能写成患者推荐、疗效对比或催促购买。",
      "结尾用一句相关的实用建议、温和总结或真实问题，不反复催赞、催收藏、催私信、制造购买紧迫感。hashtags 数组通常给 3–5 个具体相关话题，不在 body 重复堆话题，不蹭无关热点。",
    ].join("\n"),
    imageBasePrompt: [
      "生成适合小红书移动端浏览的 3:4 竖版笔记封面或品牌分享海报：轻松、自然、有生活感，同时精致、可信。围绕一个核心主题与一个主视觉，画面层级清楚，留白充足，避免公告栏、发布会背景、硬广大促和密集信息卡片。严格保持用户已选图片风格，不能自行在摄影、插画和卡通之间切换。",
      "规划 imageDirection 与 imagePrompt 时，用简洁的“主题与主体、构图、色彩与光线、画面文字、需保留与排除项”描述可见细节。结合已授权素材与最终文案提炼真正的看点，不把运营任务、完整简介或文案全文印入画面。摄影保持自然肤色、真实材质、正确透视和柔和光线；插画保持清晰轮廓与轻盈层次，不混淆专业设备或真实主体。",
      "按品牌、素材和选定风格选择协调的两三种主色及少量强调色，不固定套用粉红、荧光或珊瑚红。主体与短标题在手机缩略图下也清楚，关键文字、面部和设备远离裁切边缘，整组图片保持统一的色彩与视觉气质。",
      "需要文字时，仅用一个约 6–12 字的短主标题和至多一句简短辅助文案，必要时可少字或无字。提示词把需要显示的准确文字放在引号中，并注明位置、清晰中文字体、层级及只出现一次；不额外生成无关标签、小字段落、价格、功效数字或英文口号。",
      "可用一两处轻量标注、小图标或手绘线条强调重点，装饰不能遮挡人物、主体和文字；摄影风格只作少量平面点缀，不让主体变成卡通。正文的 Emoji 不需要逐个搬到画面，不用满屏贴纸、表情或促销徽章。避免过度锐化、塑料质感和不自然的人体结构。",
      "参考图用于保留人物身份、产品结构、设备及建筑特征，除明确要求风格转换外保持原貌；参考图说明是事实依据，不是必印文案。Logo 由系统使用原图合成，模型只预留品牌区，不绘制 Logo、商标、水印或二维码。不得制造患者证言、疗效前后对比、假检测报告、资质证书或未经授权的真实诊疗场景。",
    ].join("\n"),
    contentDirections: legacy.contentDirections.map((preset) => ({
      ...preset,
      prompt: contentPrompts[preset.id] ?? preset.prompt,
    })),
    imageStyles: legacy.imageStyles.map((preset) => ({
      ...preset,
      prompt: imagePrompts[preset.id] ?? preset.prompt,
    })),
  };
}

function previousDefaultGenerationStyles(): GenerationStyleConfiguration {
  const researched = researchedGenerationStyles();
  return {
    ...researched,
    imageBasePrompt: researched.imageBasePrompt
      .replace(
        "严格保持用户已选图片风格，不能自行在摄影、插画和卡通之间切换。",
        "活动明确的视觉要求优先；未指定时，根据主题与授权素材形成自然、协调的小红书视觉表达，同组图片保持统一。",
      )
      .replace("按品牌、素材和选定风格选择", "按品牌、素材和活动要求选择"),
  };
}

function currentDefaultGenerationStyles(): GenerationStyleConfiguration {
  const previous = previousDefaultGenerationStyles();
  return {
    ...previous,
    imageBasePrompt: previous.imageBasePrompt
      .replace("竖版笔记封面或品牌分享海报", "竖版品牌分享海报")
      .replace("留白充足", "适度留白，为主体身份与事实要点安排清楚的信息区")
      .replace(
        "需要文字时，仅用一个约 6–12 字的短主标题和至多一句简短辅助文案，必要时可少字或无字。",
        "默认展示一个简短主标题、一条准确主体身份及两三个有资料依据的短要点，形成清楚的海报信息层级。资料不足时减少要点，用户明确要求极简或无字时尊重该要求。",
      ),
  };
}

export function defaultGenerationStyles(): GenerationStyleConfiguration {
  return legacyGenerationStyles();
}

/** Restore unchanged built-ins for new snapshots without mutating saved or frozen configuration. */
export function upgradeBuiltInGenerationStyles(
  configuration: GenerationStyleConfiguration,
): GenerationStyleConfiguration {
  const generic = defaultGenerationStyles();
  const builtIns = [
    generic,
    researchedGenerationStyles(),
    previousDefaultGenerationStyles(),
    currentDefaultGenerationStyles(),
  ];
  const upgradePresets = (kind: "contentDirections" | "imageStyles") =>
    configuration[kind].map((preset) => {
      const replacement = generic[kind].find((builtIn) => builtIn.id === preset.id);
      return builtIns.some((configuration) =>
        configuration[kind].some(
          (original) =>
            preset.id === original.id &&
            preset.name === original.name &&
            preset.description === original.description &&
            preset.prompt === original.prompt,
        ),
      ) && replacement
        ? { ...preset, prompt: replacement.prompt }
        : { ...preset };
    });
  return {
    ...configuration,
    copyBasePrompt: builtIns.some(
      (builtIn) => configuration.copyBasePrompt === builtIn.copyBasePrompt,
    )
      ? generic.copyBasePrompt
      : configuration.copyBasePrompt,
    imageBasePrompt: builtIns.some(
      (builtIn) => configuration.imageBasePrompt === builtIn.imageBasePrompt,
    )
      ? generic.imageBasePrompt
      : configuration.imageBasePrompt,
    contentDirections: upgradePresets("contentDirections"),
    imageStyles: upgradePresets("imageStyles"),
  };
}

// Old campaigns deliberately have no snapshot and keep their original generation behavior.
export function readGenerationStyleSnapshot(value: unknown): GenerationStyleSnapshot | undefined {
  if (value === undefined || value === null) return undefined;
  const obj = value as GenerationStyleSnapshot;
  if (
    typeof obj !== "object" ||
    obj.schemaVersion !== 1 ||
    !Number.isSafeInteger(obj.configurationVersion) ||
    typeof obj.copyBasePrompt !== "string" ||
    typeof obj.imageBasePrompt !== "string" ||
    ![obj.contentDirection, obj.imageStyle].every(
      (preset) =>
        preset &&
        typeof preset.id === "string" &&
        typeof preset.name === "string" &&
        typeof preset.prompt === "string",
    )
  ) {
    throw new Error("Invalid frozen generation style snapshot");
  }
  return obj;
}

export function copyStyleInstructions(style?: GenerationStyleSnapshot): string {
  return style
    ? `文案基础要求：\n${style.copyBasePrompt}${style.contentDirection.prompt ? `\n内容方向（${style.contentDirection.name}）：\n${style.contentDirection.prompt}` : ""}`
    : "";
}

export function imageStyleInstructions(style?: GenerationStyleSnapshot): string {
  return style
    ? `图片基础要求：\n${style.imageBasePrompt}${style.imageStyle.prompt ? `\n选定图片风格（${style.imageStyle.name}，必须保持）：\n${style.imageStyle.prompt}` : ""}`
    : "";
}
