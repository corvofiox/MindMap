interface EditingState {
  nodeId: string | null
  field: 'title' | 'content' | null
}

const editingState: EditingState = {
  nodeId: null,
  field: null,
}

let localEditingUpdateFlag = false

export function setLocalEditingUpdate(value: boolean) {
  localEditingUpdateFlag = value
}

export function isLocalEditingUpdate(): boolean {
  return localEditingUpdateFlag
}

export function setEditingFieldForCollab(nodeId: string | null, field: 'title' | 'content' | null) {
  editingState.nodeId = nodeId
  editingState.field = field
}

export function getEditingState(): EditingState {
  return { ...editingState }
}

export function dispatchEditingFieldChange(
  field: 'title' | 'content' | null,
  nodeId: string | null
) {
  window.dispatchEvent(
    new CustomEvent('nodeEditingFieldChange', {
      detail: { field, nodeId },
    })
  )
}
