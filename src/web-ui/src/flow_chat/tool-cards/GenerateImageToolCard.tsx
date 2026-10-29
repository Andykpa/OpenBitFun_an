import React, { useMemo } from 'react';
import {
  ImageAnalysisToolCard,
  type SemanticToolCardProps,
} from '@openbitfun/ui/flow-chat';
import { useI18n } from '@/infrastructure/i18n';
import type { ToolCardProps } from '../types/flow-chat';
import { buildBuiltinToolCardModel } from './builtinToolCardModel';
import { getToolCardStatusDescription } from './toolCardStatus';
import { useToolCardHeightContract } from './useToolCardHeightContract';

/**
 * Generated images are user-facing output, so keep their preview visible in
 * the transcript instead of putting it behind the regular tool disclosure.
 */
export const GenerateImageToolCard: React.FC<ToolCardProps> = ({ toolItem }) => {
  const { t, formatNumber } = useI18n('flow-chat');
  const model = useMemo(
    () => buildBuiltinToolCardModel(toolItem, 'generate_image', t, formatNumber),
    [toolItem, t, formatNumber],
  );
  const { cardRootRef, dispatchToolCardToggle } = useToolCardHeightContract({
    toolId: toolItem.id,
    toolName: toolItem.toolName,
  });

  const media = model.imageSources.length > 0
    ? model.imageSources.map((source, index) => (
      <img
        key={`${toolItem.id}-${index}`}
        src={source}
        alt={model.summary ?? model.action}
        loading="lazy"
        onLoad={dispatchToolCardToggle}
      />
    ))
    : undefined;

  const card: SemanticToolCardProps = {
    status: model.status,
    action: model.action,
    attention: model.attention,
    summary: model.summary,
    resultSummary: model.resultSummary,
    outcome: model.outcome,
    fields: model.fields,
    sections: model.sections,
    emptyContent: model.emptyContent,
    error: model.error,
    media,
    detailsAvailable: Boolean(media || model.rawResult !== undefined),
    // A generated image is the result of this tool call, so it stays visible
    // and this card deliberately has no disclosure callback.
    isExpanded: true,
    statusDescription: getToolCardStatusDescription(model.status, t, model.error),
  };

  return (
    <div
      ref={cardRootRef}
      data-openbitfun-adapter="generate-image"
      data-tool-card-id={toolItem.id}
      data-tool-card-kind="generate-image"
    >
      <ImageAnalysisToolCard {...card} />
    </div>
  );
};
