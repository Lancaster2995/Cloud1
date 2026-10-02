import SwiftUI

struct GuideView: View {
    @EnvironmentObject private var store: Store

    var body: some View {
        Form {
            Section("Ajustes") {
                Toggle("Insertar los prompts directamente en el cuadro de mensaje (si no, solo se copian)",
                       isOn: Binding(get: { store.data.autoInsert }, set: { v in store.edit { $0.autoInsert = v } }))
            }
            Section("Cómo funciona") {
                step(1, "Cuentas: agrega cada cuenta de Claude que uses. Cada una tiene su propia sesión con cookies separadas (como perfiles distintos del navegador), así varias sesiones siguen iniciadas a la vez y cambias entre ellas al instante.")
                step(2, "Inicia sesión una vez en cada cuenta con tu correo: escribe tu dirección (también sirve tu Gmail) y usa el código o enlace que te llega. Si es un enlace, mantenlo pulsado en Mail, cópialo y ábrelo en la cuenta con ⋯ → «Abrir un enlace aquí» (si lo abres directamente, la sesión quedaría en Safari).")
                step(3, "Proyectos: crea un proyecto con su objetivo (y repositorio, si lo hay). En la sesión de una cuenta elige el proyecto arriba y pulsa «📨 Traspaso»: el prompt de inicio queda en el cuadro de mensaje. Revísalo y envíalo.")
            }
            Section("Pasar el proyecto a otra cuenta") {
                step(1, "Pulsa «🧭 Pedir estado» y envía el mensaje. Claude responde con un bloque <<<ESTADO … ESTADO>>>.")
                step(2, "Pulsa «💾 Guardar»: Relevo lee ese bloque de la conversación y lo guarda como checkpoint con su % de progreso.")
                step(3, "Pulsa «⇄ Pasar», elige la cuenta destino y, si la actual llegó a su límite, cuánto pausarla. Relevo registra el traspaso, te avisa con una notificación cuando la cuenta vuelve a estar disponible y cambia a la otra cuenta.")
                step(4, "En la cuenta destino aparece «Traspaso pendiente»: pulsa «Insertar prompt» y envía el mensaje. Repite hasta terminar.")
            }
            Section("Iniciar sesión con Google") {
                Text("Google no permite «Continuar con Google» dentro de apps porque no son un navegador completo, y Relevo no intenta saltarse esa protección. Entra con tu correo (tu dirección de Gmail sirve: Claude te envía un código o enlace), o usa esa cuenta en Safari y copia los prompts desde Detalles del proyecto.")
            }
            Section("Varias sesiones a la vez") {
                Text("Toca el nombre de la cuenta arriba para cambiar de cuenta al instante: las demás sesiones siguen abiertas. En iPad, ⋯ → «Abrir otra cuenta al lado» muestra dos cuentas en paralelo.")
            }
            Section("Entre dispositivos") {
                Text("Los proyectos usan el mismo formato en iPhone, Windows y Android: en Detalles → «Compartir JSON» o «Copiar JSON», y en el otro dispositivo Proyectos → Importar.")
            }
            Section("Con código (Claude Code)") {
                Text("Si el proyecto tiene repositorio, los prompts piden a Claude hacer commit y push de cada avance y mantener el bloque de estado en HANDOFF.md, así el estado viaja también con el código.")
            }
            Section("Privacidad y límites") {
                Text("Relevo no envía mensajes ni automatiza Claude: solo coloca texto en el cuadro de mensaje cuando pulsas un botón, y tú decides enviarlo. Todo se guarda solo en este dispositivo. Usa solo tus propias cuentas y respeta los Términos de uso de Anthropic.")
            }
            Section {
                Text("Relevo \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "")")
                    .font(.footnote).foregroundStyle(Theme.text2)
                    .frame(maxWidth: .infinity)
            }
        }
        .navigationTitle("Guía y ajustes")
    }

    private func step(_ n: Int, _ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text("\(n)").font(.footnote.bold()).foregroundStyle(.white)
                .frame(width: 22, height: 22)
                .background(Circle().fill(Theme.accent))
            Text(text).font(.subheadline)
        }
        .padding(.vertical, 2)
    }
}
