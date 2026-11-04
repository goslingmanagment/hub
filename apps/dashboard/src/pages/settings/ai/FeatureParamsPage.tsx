import { Link, useLocation, useParams } from "react-router";
import { useAdminConfig } from "@/api/adminConfig";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { KeyValue } from "@/components/ui/KeyValue";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { ConfigurationView } from "../ConfigurationTab.js";
import { featureReturnHref, findHubFeature } from "../featureCatalog.js";
import { featureState, featureStatus } from "../featuresView.js";

/**
 * One AI feature's parameters: what it is now and what switching it off would do,
 * then the same rows and editors as «Все параметры», only this feature's keys
 * (design/screens/settings.md §5). Every switch here asks a second press: they
 * change the AI's answers. The target of a write is the row's key.
 */
export function FeatureParamsPage() {
  const { featureId } = useParams<{ featureId: string }>();
  const { hash, state } = useLocation();
  const feature = findHubFeature(featureId);
  const query = useAdminConfig();

  if (!feature) {
    return (
      <>
        <PageHeader title="Такой функции нет" />
        <StatusPanel
          title="Такой функции нет"
          description="Возможно, ссылка устарела."
          action={<Link to="/settings/ai/features" className="btn btn-sm">К функциям ИИ</Link>}
        />
      </>
    );
  }

  const current = query.data ? featureState(feature, query.data) : null;
  const status = current ? featureStatus(feature, current) : null;

  return (
    <>
      <PageHeader
        title={feature.title}
        description={feature.summary}
        fresh={query.data ? { at: query.data.generatedAt, onRefresh: () => void query.refetch(), refreshing: query.isFetching } : undefined}
      />
      <div className="stack">
        <KeyValue rows={[
          {
            label: "Сейчас",
            value: current && status
              ? <span className="settings-now"><StatusBadge status={status.word} /><span>{current.detail}</span></span>
              : null,
          },
          { label: "Если отключить", value: feature.consequence },
        ]} />
        <ConfigurationView
          hash={hash}
          feature={feature}
          featureHeader={false}
          alwaysConfirm
          navigationState={state}
          allSettingsHref="/system/dev/config"
          featureBackTo={featureReturnHref(feature)}
        />
      </div>
    </>
  );
}
