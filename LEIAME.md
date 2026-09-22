# Escritório — casca do app

Página estática. **Não contém dado nenhum**: dono do repositório, token e senha
são digitados no aparelho e ficam no aparelho.

O estado do escritório vive cifrado (AES-256-GCM) num repositório privado
separado. Esta página só sabe decifrar — e só consegue com a senha, que nunca
é guardada em lugar nenhum.

Código-fonte da ponte: repositório privado `escritorio-jarvis`, pasta `ponte/`.
