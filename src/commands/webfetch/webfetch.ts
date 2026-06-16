import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { Select, type OptionWithDescription } from '../../components/CustomSelect/index.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { getSmallFastModel, modelDisplayString } from '../../utils/model/model.js'
import { getModelOptions } from '../../utils/model/modelOptions.js'

const DEFAULT_WEBFETCH_MODEL = '__DEFAULT_WEBFETCH_MODEL__'

type WebFetchModelPickerValue = string

function webFetchModelLabel(): string {
  const model = getGlobalConfig().webFetchModel
  return model ? `override (${model})` : `default Haiku (${getSmallFastModel()})`
}

function WebFetchModelPicker({
  onDone,
}: {
  onDone: (result?: string, options?: { display?: 'system' | 'skip' }) => void
}): React.ReactNode {
  const current = getGlobalConfig().webFetchModel
  const defaultModel = getSmallFastModel()
  const options: OptionWithDescription<WebFetchModelPickerValue>[] = [
    {
      value: DEFAULT_WEBFETCH_MODEL,
      label: 'Default Haiku',
      description: defaultModel,
    },
    ...getModelOptions(false)
      .filter(option => option.value !== null)
      .map(option => ({
        value: option.value as string,
        label: option.label,
        description: option.description,
      })),
  ]
  const defaultValue = current ?? DEFAULT_WEBFETCH_MODEL
  const defaultFocusValue = options.some(option => option.value === defaultValue)
    ? defaultValue
    : DEFAULT_WEBFETCH_MODEL

  return React.createElement(
    Box,
    { flexDirection: 'column' },
    React.createElement(
      Box,
      { marginBottom: 1, flexDirection: 'column' },
      React.createElement(Text, { color: 'remember', bold: true }, 'Select WebFetch model'),
      React.createElement(
        Text,
        { dimColor: true },
        'Only WebFetch page summarization/extraction uses this model. Main chat model is unchanged.',
      ),
    ),
    React.createElement(Select<WebFetchModelPickerValue>, {
      defaultValue,
      defaultFocusValue,
      options,
      visibleOptionCount: Math.min(10, options.length),
      onCancel: () => {
        onDone(`Kept WebFetch model as ${webFetchModelLabel()}`, {
          display: 'system',
        })
      },
      onChange: value => {
        if (value === DEFAULT_WEBFETCH_MODEL) {
          saveGlobalConfig(c => ({ ...c, webFetchModel: undefined }))
          onDone(`WebFetch model reset to default Haiku (${defaultModel}).`)
          return
        }
        saveGlobalConfig(c => ({ ...c, webFetchModel: value }))
        onDone(
          `WebFetch model set to ${modelDisplayString(value)}. Main chat model unchanged.`,
        )
      },
    }),
  )
}

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const say = (message: string): null => {
    onDone(message, { display: 'system' })
    return null
  }

  const trimmed = (args ?? '').trim()
  const sub = (trimmed.split(/\s+/)[0] ?? '').toLowerCase()
  const restStr = trimmed.slice(sub.length).trim()

  if (!sub || sub === 'status' || sub === 'current') {
    return say(
      `Current WebFetch model: **${webFetchModelLabel()}**\n\nUse \`/webfetch model\` to choose a model, or \`/webfetch model default\` to reset.`,
    )
  }

  if (sub === 'model') {
    if (!restStr) {
      return React.createElement(WebFetchModelPicker, { onDone })
    }
    if (restStr.toLowerCase() === 'default' || restStr.toLowerCase() === 'reset') {
      saveGlobalConfig(c => ({ ...c, webFetchModel: undefined }))
      return say(`WebFetch model reset to **default Haiku (${getSmallFastModel()})**.`)
    }
    saveGlobalConfig(c => ({ ...c, webFetchModel: restStr }))
    return say(
      `WebFetch model set to **${restStr}**. Main chat model unchanged.`,
    )
  }

  return say('Usage: `/webfetch model [model|default]`')
}
