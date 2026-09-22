// Minimal, source-hash-locked patch for Cubism Web 5-r.5. Preserve its original license header.
export function patchCubismShaders(original) {
  let source = original;
  const replaceOnce = (before, after) => {
    if (source.split(before).length !== 2)
      throw new Error('Cubism R5 셰이더 수명 패치의 원본이 일치하지 않습니다.');
    source = source.replace(before, after);
  };
  replaceOnce(
    'export class CubismShader_WebGL {',
    `export class CubismShader_WebGL {
  // Ouento: invalidate pending asynchronous registration when this context is released.
  private _loadGeneration = 0;`,
  );
  replaceOnce(
    `    for (let i = 0; i < this._shaderSets.length; i++) {
      this.gl.deleteProgram(this._shaderSets[i].shaderProgram);
      this._shaderSets[i].shaderProgram = 0;
      this._shaderSets[i] = void 0;
      this._shaderSets[i] = null;
    }`,
    `    this._loadGeneration++;
    // Additive/multiplicative sets share programs; delete each actual program only once.
    const programs = new Set<WebGLProgram>();
    for (const shader of this._shaderSets) {
      if (shader?.shaderProgram) programs.add(shader.shaderProgram);
    }
    for (const program of programs) this.gl.deleteProgram(program);
    this._shaderSets.length = 0;
    this._isShaderLoading = false;
    this._isShaderLoaded = false;`,
  );
  replaceOnce(
    `    this._isShaderLoading = true;
    this._isShaderLoaded = false;`,
    `    const generation = ++this._loadGeneration;
    this._isShaderLoading = true;
    this._isShaderLoaded = false;`,
  );
  replaceOnce(
    `    this.loadShaders()
      .then(() => {`,
    `    this.loadShaders()
      .then(() => {
        if (generation !== this._loadGeneration) return;`,
  );
  replaceOnce(
    `      .catch(error => {
        this._isShaderLoading = false;
        console.error('Failed to load shaders:', error);`,
    `      .catch(error => {
        if (generation !== this._loadGeneration) return;
        this.releaseShaderProgram();
        console.error('Failed to load shaders:', error);`,
  );
  replaceOnce(
    `  public setGlContext(gl: WebGLRenderingContext): void {`,
    `  // Ouento: release one canvas without touching other renderers in the shared manager.
  public releaseContext(gl: WebGLRenderingContext): void {
    const shader = this._shaderMap.get(gl);
    if (!shader) return;
    this._shaderMap.delete(gl);
    shader.release();
  }

  public setGlContext(gl: WebGLRenderingContext): void {`,
  );
  return source;
}
