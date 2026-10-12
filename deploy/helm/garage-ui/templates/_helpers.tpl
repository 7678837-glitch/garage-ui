{{- define "garage-ui.selectorLabels" -}}
app.kubernetes.io/name: garage-ui
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "garage-ui.labels" -}}
{{ include "garage-ui.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}
