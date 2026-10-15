import { useSearchParams } from "react-router";
import { SideNavLayout } from "@/components/layout/SectionLayouts";
import { resolveSettingsTab, type SettingsTab } from "@/lib/navigation";
import { SETTINGS_GROUPS, SYSTEM_GROUPS, SYSTEM_SETTINGS_TABS, currentSideLink } from "@/lib/sections";
import { SyncTab } from "./settings/SyncTab.js";
import { EngineTab } from "./settings/engine/EngineTab.js";
import { CollectionTab } from "./settings/CollectionTab.js";
import { PagesTab } from "./settings/PagesTab.js";
import { TeamTab } from "./settings/team/TeamTab.js";
import { ConfigurationTab } from "./settings/ConfigurationTab.js";
import { AiPersonasTab } from "./settings/AiPersonasTab.js";
import { TechnicalTab } from "./settings/team/TechnicalTab.js";
import { FeaturesTab } from "./settings/FeaturesTab.js";
import { NotificationsSettingsSection } from "./settings/NotificationsSettingsSection.js";
import { OfapiApiTab } from "./settings/OfapiApiTab.js";

const sections: Record<SettingsTab, { title: string; description: string }> = {
  pages: {
    title: "Модели и страницы",
    description: "Модели агентства, их страницы на Fansly и OnlyFans и доступ Hub к каждой странице.",
  },
  models: {
    title: "Модели и страницы",
    description: "Модели агентства, их страницы на Fansly и OnlyFans и доступ Hub к каждой странице.",
  },
  credentials: {
    title: "Модели и страницы",
    description: "Модели агентства, их страницы на Fansly и OnlyFans и доступ Hub к каждой странице.",
  },
  users: {
    title: "Команда",
    description: "Приглашения, доступ к страницам и устройства сотрудников.",
  },
  personas: {
    title: "AI-персоны",
    description: "Образы и стили общения для AI: здесь их пишут и правят, а чаттеры выбирают их в своих приложениях.",
  },
  collection: {
    title: "Сбор OnlyFans",
    description: "Что и как часто Hub загружает из OnlyFans и сколько кредитов на это уходит.",
  },
  notifications: {
    title: "Уведомления",
    description: "Telegram-бот, оповещения о сбоях и ежедневный отчёт о доходе.",
  },
  engine: {
    title: "Сбор Fansly",
    description: "Как Hub читает каждую страницу Fansly: очередь, паузы и заявки на историю.",
  },
  sync: {
    title: "Синхронизация OnlyFans",
    description: "Какие данные страниц OnlyFans обновляются и где нужна помощь.",
  },
  ofapi: {
    title: "OnlyFans API",
    description: "События вебхука, сверка с провайдером, сохранённые ответы и словарь запрещённых слов.",
  },
  features: {
    title: "Возможности",
    description: "Какие функции Hub включены и что из них стоит оставить.",
  },
  configuration: {
    title: "Все параметры",
    description: "Полный список параметров сервера. Меняйте, только если понимаете последствия.",
  },
  agentKeys: {
    title: "Ключи агентов",
    description: "Доступ AI-агентов к данным и привязка сбора данных к устройству.",
  },
};

export function SettingsPage() {
  const [searchParams] = useSearchParams();
  const activeTab = resolveSettingsTab(searchParams.get("tab"));
  const system = SYSTEM_SETTINGS_TABS.has(activeTab);
  const groups = system ? SYSTEM_GROUPS : SETTINGS_GROUPS;
  const navTab = activeTab === "models" || activeTab === "credentials" ? "pages" : activeTab;
  const current = currentSideLink(groups, "/settings", `?tab=${navTab}`);
  const section = sections[activeTab];

  return (
    <SideNavLayout
      title={system ? "Система" : "Настройки"}
      navLabel={system ? "Разделы системы" : "Разделы настроек"}
      groups={groups}
      current={current}
    >
      <section aria-labelledby="settings-section-title" className="min-w-0">
        <div className="mb-5">
          <h2 id="settings-section-title" className="section-title">{section.title}</h2>
          <p className="mt-1 max-w-3xl text-sm text-text-secondary">{section.description}</p>
        </div>
        {(activeTab === "pages" || activeTab === "models" || activeTab === "credentials") && <PagesTab />}
        {activeTab === "users" && <TeamTab />}
        {activeTab === "personas" && <AiPersonasTab />}
        {activeTab === "collection" && <CollectionTab />}
        {activeTab === "notifications" && <NotificationsSettingsSection />}
        {activeTab === "engine" && <EngineTab />}
        {activeTab === "sync" && <SyncTab />}
        {activeTab === "ofapi" && <OfapiApiTab />}
        {activeTab === "features" && <FeaturesTab />}
        {activeTab === "configuration" && <ConfigurationTab />}
        {activeTab === "agentKeys" && <TechnicalTab />}
      </section>
    </SideNavLayout>
  );
}
