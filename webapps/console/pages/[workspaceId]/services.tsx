import { WorkspacePageLayout } from "../../components/PageLayout/WorkspacePageLayout";
import { ConfigEditor, ConfigEditorProps } from "../../components/ConfigObjectEditor/ConfigEditor";
import { ServiceConfig } from "../../lib/schema";
import { useWorkspace } from "../../lib/context";
import { useRouter } from "next/router";
import { getLog, hash as jhash, randomId, rpc } from "juava";
import React from "react";
import { Modal, Space, Tooltip } from "antd";
import { serialization, useURLPersistedState } from "../../lib/ui";
import { ServicesCatalog } from "../../components/ServicesCatalog/ServicesCatalog";
import { SourceType } from "../api/sources";
import hash from "stable-hash";
import { ServiceEditor } from "../../components/ServiceEditor/ServiceEditor";
import { ErrorCard } from "../../components/GlobalError/GlobalError";

const log = getLog("services");

const Services: React.FC<any> = () => {
  const router = useRouter();
  console.log("router", router.pathname);
  return (
    <WorkspacePageLayout>
      <ServicesList />
    </WorkspacePageLayout>
  );
};

export const ServiceTitle: React.FC<{
  service?: ServiceConfig;
  size?: "small" | "default" | "large";
  title?: (d: ServiceConfig) => string;
}> = ({ service, title = d => d.name, size = "default" }) => {
  const iconClassName = (() => {
    switch (size) {
      case "small":
        return "h-4 w-4";
      case "large":
        return "h-16 w-16";
      default:
        return "h-8 w-8";
    }
  })();
  return (
    <Space size={"small"}>
      <div className={iconClassName}>
        <img
          alt={service?.package}
          src={`/api/sources/logo?type=${service?.protocol}&package=${encodeURIComponent(service?.package ?? "")}`}
        />
      </div>
      <div>
        <Tooltip title={`${service?.package}:${service?.version}`}>
          {service ? title(service) : "Unknown service"}
        </Tooltip>
      </div>
    </Space>
  );
};

const ServicesList: React.FC<{}> = () => {
  const workspace = useWorkspace();

  const [showCatalog, setShowCatalog] = useURLPersistedState<boolean>("showCatalog", {
    defaultVal: false,
    type: serialization.bool,
  });
  const router = useRouter();

  if (!workspace.featuresEnabled || !workspace.featuresEnabled.includes("syncs")) {
    return (
      <ErrorCard
        title={"Feature is not enabled"}
        error={{ message: "'Sources Sync' feature is not enabled for current project." }}
        hideActions={true}
      />
    );
  }

  const config: ConfigEditorProps<ServiceConfig, SourceType> = {
    listColumns: [
      {
        title: "Package",
        render: (c: ServiceConfig) => <ServiceTitle service={c} title={c => `${c?.package}:${c?.version}`} />,
      },
    ],
    objectType: ServiceConfig,
    fields: {
      type: { constant: "service" },
      workspaceId: { constant: workspace.id },
      protocol: { hidden: true },
      package: { hidden: true },
    },
    noun: "service",
    type: "service",
    explanation: "Services are used to connect to external systems",
    editorComponent: () => ServiceEditor,
    loadMeta: async (obj?: ServiceConfig) => {
      let packageType = "";
      let packageId = "";
      if (obj) {
        packageType = obj.protocol;
        packageId = obj.package;
      } else {
        packageType = router.query["packageType"] as string;
        packageId = router.query["packageId"] as string;
      }
      const rawVersions = await rpc(
        `/api/sources/versions?type=${packageType}&package=${encodeURIComponent(packageId)}`
      );
      const versions = rawVersions.versions.filter((v: any) => v.isRelease).map((v: any) => v.name);
      const sourceType = await rpc(`/api/sources/${packageType}/${encodeURIComponent(packageId)}`);

      return {
        ...sourceType,
        versions,
      };
    },
    newObject: meta => {
      if (meta) {
        return {
          name: meta.meta.name,
          protocol: meta.packageType as ServiceConfig["protocol"],
          package: meta.packageId,
          version: meta.versions[0],
        };
      } else {
        throw new Error("Failed to load service metadata");
      }
    },
    testConnectionEnabled: (obj: ServiceConfig) => {
      return true;
    },
    onTest: async obj => {
      console.log("Testing service", obj, typeof obj);
      try {
        //hash object to avoid sending credentials to the server
        const queryId = randomId();
        const h = jhash("md5", hash(JSON.parse(obj.credentials)));
        const storageKey = `${workspace.id}_${obj.id}_${h}_${queryId}`;
        const res = await rpc(`/api/${workspace.id}/sources/check?storageKey=${storageKey}`, {
          method: "POST",
          body: obj,
        });
        if (res.error) {
          return res;
        }
        for (let i = 0; i < 60; i++) {
          const res = await rpc(`/api/${workspace.id}/sources/check?storageKey=${storageKey}`);
          if (!res.pending) {
            return res;
          }
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        return { ok: false, error: "Connection test timeout." };
      } catch (error) {
        log
          .atWarn()
          .log(
            `Failed to test service ${workspace.id} / ${obj.package}. This is not expected since service tester should return 200 even in credentials are wrong`,
            error
          );
        return { ok: false, error: "Internal error, see logs for details" };
        //feedbackError("Failed to test object", { error });
      }
    },
    addAction: () => {
      setShowCatalog(true);
    },
    editorTitle: (obj: ServiceConfig, isNew: boolean, meta) => {
      if (!meta) {
        throw new Error("Failed to load service metadata");
      }
      const verb = isNew ? "New" : "Edit";
      return (
        <div className="flex items-center">
          <div className="h-12 w-12 mr-4">{<img src={meta.logo} alt={meta.packageId} />}</div>
          {verb} service: {meta.meta.name}
        </div>
      );
    },
    subtitle: (obj: ServiceConfig, isNew: boolean, meta) => {
      return `${obj.package || meta!.packageId}`;
    },
  };
  return (
    <>
      <Modal
        bodyStyle={{ overflowY: "auto", maxHeight: "calc(100vh - 200px)" }}
        open={showCatalog}
        width="90vw"
        onCancel={() => setShowCatalog(false)}
        footer={null}
      >
        <ServicesCatalog
          onClick={(packageType, packageId) => {
            setShowCatalog(false);
            router.push(
              `/${workspace.id}/services?id=new&packageType=${packageType}&packageId=${encodeURIComponent(packageId)}`
            );
          }}
        />
      </Modal>
      <ConfigEditor {...(config as any)} />
    </>
  );
};

export default Services;