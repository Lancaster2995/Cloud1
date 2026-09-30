import XCTest
@testable import Relevo

final class RelevoTests: XCTestCase {
    private let answer = """
    <<<ESTADO
    PROYECTO: Tienda
    PROGRESO: 45%
    RESUMEN: Backend listo, falta el frontend.
    HECHO:
    - API de productos
    - Autenticación
    EN_PROGRESO:
    - Carrito (falta el total)
    SIGUIENTES_PASOS:
    - Terminar el carrito
    - Pagos con Stripe
    DECISIONES:
    - PostgreSQL por las transacciones
    BLOQUEOS:
    - ninguno
    ARCHIVOS_CLAVE:
    - api/server.ts: rutas
    CONTEXTO_EXTRA:
    npm run dev en el puerto 3000
    ESTADO>>>
    """

    private func project() -> Project {
        var p = Project()
        p.name = "Tienda"
        p.goal = "Tienda online"
        p.repo = "https://github.com/demo/tienda"
        p.branch = "main"
        return p
    }

    private func tempStore() -> Store {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("relevo-test-\(UUID().uuidString).json")
        return Store(url: url)
    }

    // MARK: parser

    func testFindsAnswerAfterTemplate() {
        let page = "Tú: " + Prompts.checkpoint(project()) + "\n\nClaude:\n```\n" + answer + "\n```\nCopiar"
        let r = StateBlock.find(page, requireEnd: true)
        XCTAssertNotNil(r.block)
        XCTAssertFalse(r.newestIsTemplate)
        XCTAssertEqual(StateBlock.progress(r.block), 45)
        XCTAssertTrue(r.block!.hasPrefix(StateBlock.start))
        XCTAssertTrue(r.block!.hasSuffix(StateBlock.end))
    }

    func testUnansweredTemplateIsReported() {
        let page = "Claude:\n```\n" + answer + "\n```\nTú: " + Prompts.checkpoint(project())
        let r = StateBlock.find(page, requireEnd: true)
        XCTAssertTrue(r.newestIsTemplate)
        XCTAssertNotNil(r.block)
    }

    func testStreamingBlockNeedsEndOnPage() {
        let partial = String(answer[..<answer.range(of: "DECISIONES")!.lowerBound])
        XCTAssertNil(StateBlock.find(partial, requireEnd: true).block)
        let clip = StateBlock.find(partial, requireEnd: false)
        XCTAssertNotNil(clip.block)
        XCTAssertEqual(StateBlock.progress(clip.block), 45)
    }

    func testSectionsAndItems() {
        XCTAssertEqual(StateBlock.items(answer, "SIGUIENTES_PASOS"), ["Terminar el carrito", "Pagos con Stripe"])
        XCTAssertEqual(StateBlock.section(answer, "RESUMEN"), "Backend listo, falta el frontend.")
        XCTAssertEqual(StateBlock.section(answer, "CONTEXTO_EXTRA"), "npm run dev en el puerto 3000")
        XCTAssertEqual(StateBlock.items(answer, "HECHO").count, 2)
    }

    func testToleratesMarkdownDecoration() {
        let md = "<<<ESTADO\n**PROGRESO:** 120 %\n**SIGUIENTES_PASOS:**\n* uno\n* dos\nESTADO>>>"
        XCTAssertEqual(StateBlock.progress(md), 100)
        XCTAssertEqual(StateBlock.items(md, "SIGUIENTES_PASOS").count, 2)
    }

    func testMissingProgressAndBlock() {
        XCTAssertEqual(StateBlock.progress("<<<ESTADO\nRESUMEN: x\nESTADO>>>"), -1)
        XCTAssertNil(StateBlock.find("sin bloque", requireEnd: false).block)
    }

    func testNormalize() {
        XCTAssertEqual(StateBlock.normalize("```\n<<<ESTADO   \nRESUMEN: a  \n\n\n\nHECHO:\nESTADO>>>\n```"),
                       "<<<ESTADO\nRESUMEN: a\n\nHECHO:\nESTADO>>>")
    }

    func testPromptsCarryStateAndRepo() {
        var p = project()
        let start = Prompts.start(p)
        XCTAssertTrue(start.contains("«Tienda»"))
        XCTAssertTrue(start.contains("HANDOFF.md"))
        XCTAssertTrue(StateBlock.isTemplate(start))
        p.state = StateBlock.find(answer, requireEnd: true).block!
        p.stateTime = 1_700_000_000_000
        let handoff = Prompts.handoff(p)
        XCTAssertTrue(handoff.contains("SIGUIENTES_PASOS"))
        XCTAssertTrue(handoff.contains("github.com/demo/tienda"))
        XCTAssertFalse(StateBlock.isTemplate(handoff))
        let r = StateBlock.find("Tú: " + handoff, requireEnd: true)
        XCTAssertFalse(r.newestIsTemplate)
        XCTAssertEqual(r.block, p.state)
        XCTAssertEqual(Prompts.nextStep(p), "Terminar el carrito")
    }

    func testTemplateHasEveryKey() {
        XCTAssertEqual(StateBlock.knownKeys(Prompts.template("X")), StateBlock.keys.count)
    }

    func testInsertScriptEscapesText() {
        let script = PageScripts.insert("línea \"1\"\nlínea 2 </script>")
        XCTAssertTrue(script.hasSuffix(")"))
        XCTAssertTrue(script.contains("\\\"1\\\""))
        XCTAssertTrue(script.contains("\\n"))
    }

    // MARK: store

    func testAccountsProjectsCheckpointsTransfers() throws {
        let store = tempStore()
        XCTAssertEqual(try store.saveAccount(slot: 0, name: "Personal", note: "", color: "#D97757", startUrl: ""), 1)
        XCTAssertEqual(try store.saveAccount(slot: 0, name: "Trabajo", note: "", color: "#4F7DF3", startUrl: ""), 2)
        let id = try store.createProject(name: "Tienda", goal: "x", repo: "", branch: "", slot: 1)
        XCTAssertEqual(store.data.account(1)?.activeProjectId, id)
        XCTAssertTrue(store.saveCheckpoint(id, slot: 1, block: answer))
        XCTAssertFalse(store.saveCheckpoint(id, slot: 1, block: answer))
        XCTAssertEqual(store.data.project(id)?.progress, 45)
        let until = store.transfer(id, from: 1, to: 2, pauseMs: 3_600_000)
        XCTAssertGreaterThan(until, Relevo.now())
        let p = try XCTUnwrap(store.data.project(id))
        XCTAssertEqual(p.currentSlot, 2)
        XCTAssertEqual(p.pendingSlot, 2)
        XCTAssertEqual(store.data.account(2)?.activeProjectId, id)
        XCTAssertTrue(Prompts.describe(p.history.last!).contains("Personal → Trabajo"))
        store.handoffDone(id, slot: 2)
        XCTAssertEqual(store.data.project(id)?.pendingSlot, 0)

        // Persisted to disk and read back.
        let reopened = Store(url: store.url)
        XCTAssertEqual(reopened.data, store.data)

        store.deleteAccount(2)
        XCTAssertEqual(store.data.project(id)?.currentSlot, 0)
    }

    func testImportsExportsFromOtherPlatforms() throws {
        let store = tempStore()
        // Written by Android (Data.Project.toJson) / Windows (model.js): same field names.
        let android = """
        {"id":"abc","name":"Desde Android","goal":"g","repo":"","branch":"","notes":"","state":"","progress":45,
         "currentSlot":3,"pendingSlot":0,"stateTime":1,"created":1,"updated":1,
         "history":[{"time":1,"type":"checkpoint","slot":3,"toSlot":0,"progress":45,"accountName":"Cel","toAccountName":"","text":"x"}]}
        """
        let p = try store.importText(android)
        XCTAssertEqual(p.name, "Desde Android")
        XCTAssertEqual(p.currentSlot, 0)
        XCTAssertEqual(p.history.count, 1)

        let fromBlock = try store.importText("hola\n" + answer)
        XCTAssertEqual(fromBlock.name, "Tienda")
        XCTAssertEqual(fromBlock.progress, 45)

        // Our own export imports again as a copy.
        let copy = try store.importText(store.exportJSON(fromBlock.id))
        XCTAssertNotEqual(copy.id, fromBlock.id)
        XCTAssertEqual(copy.state, fromBlock.state)
        XCTAssertEqual(store.data.projects.count, 3)

        XCTAssertThrowsError(try store.importText("nada"))
    }

    func testDecodesWholeDesktopDocument() throws {
        let json = """
        {"version":1,"autoInsert":false,"windows":{},"accounts":[{"slot":1,"name":"Personal","note":"","color":"#D97757",
         "startUrl":"https://claude.ai/new","pausedUntil":0,"lastActive":0,"activeProjectId":""}],"projects":[]}
        """
        let d = try JSONDecoder().decode(AppData.self, from: Data(json.utf8))
        XCTAssertEqual(d.accounts.first?.name, "Personal")
        XCTAssertFalse(d.autoInsert)
    }

    func testDataStoreIdentifiersAreStableAndDistinct() {
        XCTAssertEqual(WebSessions.storeIdentifier(1), WebSessions.storeIdentifier(1))
        XCTAssertNotEqual(WebSessions.storeIdentifier(1), WebSessions.storeIdentifier(2))
    }
}
