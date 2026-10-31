/* global user_pref */
// The always-on ChatSpace tab's preferences, written into the profile before
// every start of Firefox (s6-rc.d/firefox/run): Firefox reads user.js at each
// start and these win over what was changed by hand. What the policies say
// (policies.json) is not repeated here.

// Every start opens the homepage — ChatSpace's Accounts Overview (`/`), a
// view that opens no fan's chat — never the tabs of the last session: a
// chat someone opened by hand is not opened again after a restart or a
// crash (opening a chat marks it read on OnlyFans).
user_pref("browser.startup.page", 1);
user_pref("browser.sessionstore.resume_from_crash", false);
user_pref("browser.sessionstore.max_resumed_crashes", 0);
// No «start in Troubleshoot Mode?» after a few crashes at start: it would
// wait for a click forever.
user_pref("toolkit.startup.max_resumed_crashes", -1);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("startup.homepage_welcome_url", "");
user_pref("startup.homepage_welcome_url.additional", "");
user_pref("browser.aboutwelcome.enabled", false);
user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);
user_pref("browser.tabs.warnOnClose", false);
user_pref("browser.warnOnQuit", false);
user_pref("browser.warnOnQuitShortcut", false);
// A restart of Firefox never waits on a page's «leave this page?».
user_pref("dom.disable_beforeunload", true);

// The tab is never unloaded to save memory: its socket is the feed.
user_pref("browser.tabs.unloadOnLowMemory", false);

// The extension's update feed is read every hour, not once a day; the
// watchdog restarts Firefox after an update, so the ChatSpace tab loads the
// new version at its start.
user_pref("extensions.update.enabled", true);
user_pref("extensions.update.autoUpdateDefault", true);
user_pref("extensions.update.interval", 3600);

// Crashes: no reports sent, no dialog. Content process dumps stay in the
// profile's minidumps/, which the watchdog reads.
user_pref("browser.tabs.crashReporting.sendReport", false);
user_pref("browser.crashReports.unsubmittedCheck.enabled", false);
user_pref("browser.crashReports.unsubmittedCheck.autoSubmit2", false);

// Nothing remembered that a look at the screen could reveal.
user_pref("signon.rememberSignons", false);
user_pref("browser.formfill.enable", false);
user_pref("geo.enabled", false);
user_pref("browser.translations.automaticallyPopup", false);
user_pref("browser.newtabpage.enabled", false);

// One tab of one site: fewer content processes, a smaller disk cache.
user_pref("dom.ipc.processCount", 2);
user_pref("browser.cache.disk.capacity", 262144);

// ChatSpace in Russian, as the team reads it.
user_pref("intl.accept_languages", "ru-RU, ru, en-US, en");
