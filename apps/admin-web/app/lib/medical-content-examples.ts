export const medicalContentExamples = {
  ARRIVAL: {
    label: "首次到院",
    title: "郑州看眼科，第一次来认这扇门",
    body: "第一次来眼科，到了门口才发现不知道往哪走，真的会有点慌。我在郑州晴光眼科做接待，想先把这扇门和进门后的接待位置拍给大家看。\n\n不用把流程背下来，出发前看看主页公开的到院信息，把入口和预约方式存好，路上就少一件要操心的事。",
    useHint: "填清入口和接待位置，有门口或接待台实拍就传一张。",
    image: "/medical-examples/layout-example.svg",
  },
  ROUTE: {
    label: "到院路线",
    title: "来晴光眼科，先认这张门口照",
    body: "别光盯导航的小蓝点啦。来郑州晴光眼科，可以先看看门口长什么样，再对照主页公开的位置，认清楚沿路的参照物和实际入口。\n\n我做接待时很想把这件小事说清楚：到了附近不用急着下车绕圈，先把停车和入口信息看明白。第一次来，找路也能轻松一点。",
    useHint: "填一个附近地标和实际路线，有路口或入口实拍就传上来。",
    image: "/medical-examples/layout-example.svg",
  },
  TIME: {
    label: "时间安排",
    title: "午休来眼科，怕赶不回公司？",
    body: "午休想顺路来一趟，又怕下午上班来不及，这种安排确实容易纠结。我在郑州晴光眼科做接待，聊到时间时，会先把当天要办的事和能留出的空档说清楚。\n\n行程别塞得太满。想问当天怎么安排，可以从主页的站内咨询问起，确认好再决定哪天过来。",
    useHint: "填接待时间和影响安排的情况，有工作台实拍就传一张。",
    image: "/medical-examples/layout-example.svg",
  },
  COST: {
    label: "费用说明",
    title: "想问眼科费用，又怕被催决定",
    body: "还没决定要不要来，先想问问费用，这很正常。我在郑州晴光眼科做接待，聊预算时，会把费用包含什么、哪些需要另外确认慢慢说明白。\n\n不用为了问句话，就急着做决定。主页有公开的费用说明，想具体聊聊自己的预算和安排，也可以从主页的站内咨询问起。",
    useHint: "填费用包含和不包含什么，有不含个人信息的工作台实拍也可以传。",
    image: "/medical-examples/layout-example.svg",
  },
  FAQ: {
    label: "常见咨询",
    title: "想了解眼科，第一句怎么问？",
    body: "运动时老想扶一下眼镜，出门又总惦记有没有带眼镜盒，这些生活里的小麻烦，也可以是开始了解眼科的理由。\n\n我在郑州晴光眼科做接待，不需要你一上来就说出专业名词。先讲讲平时哪里不方便就好。主页有公开的接待方式，想了解的话，可以从自己的一个小问题聊起。",
    useHint: "填一个常见生活困扰和已确认的回答，有眼镜等日常物品实拍就传一张。",
    image: "/medical-examples/layout-example.svg",
  },
} as const;

export type MedicalExampleTopic = keyof typeof medicalContentExamples;
