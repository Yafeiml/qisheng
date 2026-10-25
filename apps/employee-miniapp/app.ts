import { loadSession } from "./utils/session";

App({
  globalData: {
    session: loadSession(),
  },
  onLaunch() {
    this.globalData.session = loadSession();
  },
});
