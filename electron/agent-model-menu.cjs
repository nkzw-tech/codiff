// @ts-check

const { getAgentMenuModels } = require('./agent.cjs');

/**
 * @param {{
 *   agent: import('./agent.cjs').Agent;
 *   models?: import('./agent.cjs').Agent['models'];
 *   onRetryPiModelDiscovery?: () => void;
 *   onSelectModel: (model: string) => void;
 *   selectedModel: string;
 * }} options
 * @returns {Array<import('electron').MenuItemConstructorOptions>}
 */
const buildAgentModelMenu = ({
  agent,
  models,
  onRetryPiModelDiscovery,
  onSelectModel,
  selectedModel,
}) => {
  const items = getAgentMenuModels(agent, selectedModel, models).map((model) => ({
    checked: selectedModel === model.id,
    click: () => onSelectModel(model.id),
    label: model.label,
    type: 'radio',
  }));
  if (agent.id === 'pi' && onRetryPiModelDiscovery) {
    items.push(
      { type: 'separator' },
      { click: onRetryPiModelDiscovery, label: 'Retry model discovery' },
    );
  }
  return items;
};

module.exports = { buildAgentModelMenu };
