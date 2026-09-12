/* =====================================================================
   A LUZ QUE REVELA — simulação de fluido (Stable Fluids, Jos Stam) na GPU
   Apresentação da vereda · adaptado do motor da apresentação de Prolog

   O ponteiro injeta tinta e velocidade na simulação. Aqui a tinta é LUZ:
   onde ela é rala, um halo dourado sobre o verde; onde é densa, revela o
   vídeo da impressora depositando o fio. E a posição horizontal do
   ponteiro controla o TEMPO do vídeo: arrastar faz a peça nascer.

   A física é a mesma do original (splat → advecção → divergência →
   pressão Jacobi 20x → gradiente → revelação); só o último passe mudou.
   As [ARMADILHA]s comentadas abaixo vieram de renderizar e comparar
   quadros, e continuam valendo.
   ===================================================================== */

window.iniciarLuz = function (opcoes) {
  var tela = opcoes.canvas;
  var video = opcoes.video;

  // --- configuração de produção -------------------------------------
  var CFG = {
    resSim: 256,               // grade da física
    resTinta: 512,             // grade da tinta: maior de propósito
    dissipacaoVelocidade: 0.962,
    dissipacaoTinta: 0.9945,   // a tinta demora mais a secar: a chapa fica
    iteracoesPressao: 20,      // Jacobi: 5 vaza volume, 60 não muda nada
    // O borrão do ponteiro: 2.5x mais largo que a referência, porque
    // aqui ele é o pincel com que a pessoa descobre a coruja, e não um
    // rastro decorativo. Raio pequeno exigia esfregar a tela.
    raioSplat: 0.00058,
    forcaSplat: 6200,
    tamanhoRevelacao: 5.4,
    // Estes dois decidem o "humor" do efeito e são o que mais importa.
    // A referência usa 0.5 / 0.01, que dá um corte nítido de estêncil.
    // Aqui a banda de transição é ~40x mais larga, porque o pedido era
    // TINTA: a coruja tem de emergir por um degradê, não por recorte.
    // O limiar tem de começar CEDO e a banda ser LARGA. Com 0.30/0.60 a
    // revelação só completava com densidade 0.23 de tinta, que a mancha
    // quase nunca alcança: a tela ficava preta. Com 0.08/0.40 ela começa
    // a aparecer com 0.02 e completa em 0.12, dando o degradê inteiro
    // dentro da faixa que o fluido realmente produz.
    suavidadeBorda: 0.035,
    larguraBorda: 0.30,
  };

  // ------------------------------------------------------------------
  // 1. CONTEXTO
  // ------------------------------------------------------------------
  // preserveDrawingBuffer: sem isso o navegador limpa o buffer depois de
  // cada composição, e qualquer engasgo do requestAnimationFrame faz o
  // hero PISCAR EM BRANCO. Num deck projetado isso é inaceitável, e o
  // custo é irrelevante para um único quad de tela cheia.
  var atributos = { alpha: true, antialias: false, depth: false,
                    stencil: false, preserveDrawingBuffer: true };
  var gl = tela.getContext("webgl2", atributos);
  var webgl2 = !!gl;
  if (!gl) {
    gl = tela.getContext("webgl", atributos)
      || tela.getContext("experimental-webgl", atributos);
  }
  if (!gl) return null;

  var formatoMeio, filtro;
  if (webgl2) {
    gl.getExtension("EXT_color_buffer_float");
    var linear2 = gl.getExtension("OES_texture_float_linear");
    formatoMeio = { interno: gl.RGBA16F, formato: gl.RGBA, tipo: gl.HALF_FLOAT };
    filtro = linear2 ? gl.LINEAR : gl.NEAREST;
  } else {
    var meio = gl.getExtension("OES_texture_half_float");
    if (!meio) return null;
    var linear1 = gl.getExtension("OES_texture_half_float_linear");
    formatoMeio = { interno: gl.RGBA, formato: gl.RGBA, tipo: meio.HALF_FLOAT_OES };
    filtro = linear1 ? gl.LINEAR : gl.NEAREST;
  }
  // Sem filtragem linear a advecção fica em blocos. Em vez de embarcar um
  // bilerp manual que ninguém vai revisar, desiste e deixa o vídeo puro.
  if (filtro !== gl.LINEAR) return null;

  // ------------------------------------------------------------------
  // 2. SHADERS
  // ------------------------------------------------------------------
  function compilar(tipo, fonte) {
    var s = gl.createShader(tipo);
    gl.shaderSource(s, fonte);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error("shader:", gl.getShaderInfoLog(s), fonte);
      return null;
    }
    return s;
  }

  function programa(fsFonte) {
    var vs = compilar(gl.VERTEX_SHADER, VERTICE);
    var fs = compilar(gl.FRAGMENT_SHADER, fsFonte);
    if (!vs || !fs) return null;
    var p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, fs);
    gl.bindAttribLocation(p, 0, "aPos");
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.error("link:", gl.getProgramInfoLog(p));
      return null;
    }
    var u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (var i = 0; i < n; i++) {
      var nome = gl.getActiveUniform(p, i).name;
      u[nome] = gl.getUniformLocation(p, nome);
    }
    return { p: p, u: u };
  }

  // O vértice já calcula os quatro vizinhos: as derivadas dos passes de
  // divergência, pressão e gradiente saem de graça, interpoladas.
  var VERTICE = [
    "precision highp float;",
    "attribute vec2 aPos;",
    "varying vec2 vUv; varying vec2 vE; varying vec2 vD; varying vec2 vC; varying vec2 vB;",
    "uniform vec2 uTexel;",
    "void main() {",
    "  vUv = aPos * 0.5 + 0.5;",
    "  vE = vUv - vec2(uTexel.x, 0.0);",
    "  vD = vUv + vec2(uTexel.x, 0.0);",
    "  vC = vUv + vec2(0.0, uTexel.y);",
    "  vB = vUv - vec2(0.0, uTexel.y);",
    "  gl_Position = vec4(aPos, 0.0, 1.0);",
    "}"
  ].join("\n");

  var CABECA = "precision highp float; precision highp sampler2D;\n" +
               "varying vec2 vUv; varying vec2 vE; varying vec2 vD; varying vec2 vC; varying vec2 vB;\n";

  // --- copiar -------------------------------------------------------
  var COPIA = CABECA +
    "uniform sampler2D uTex;" +
    "void main() { gl_FragColor = texture2D(uTex, vUv); }";

  // --- splat: injeta uma gaussiana no ponto do ponteiro -------------
  // O MESMO shader serve à velocidade e à tinta, porque somar gaussiana
  // é somar gaussiana. No campo de velocidade, R e G são vx e vy; no de
  // tinta, R é concentração. Uma textura RGBA não é "uma imagem", é um
  // array de 4 floats por célula.
  var SPLAT = CABECA +
    "uniform sampler2D uAlvo;" +
    "uniform float uProporcao;" +
    "uniform vec3 uCor;" +
    "uniform vec2 uPonto;" +
    "uniform float uRaio;" +
    "void main() {" +
    "  vec2 p = vUv - uPonto;" +
    "  p.x *= uProporcao;" +
    "  vec3 splat = exp(-dot(p, p) / uRaio) * uCor;" +
    "  vec3 base = texture2D(uAlvo, vUv).xyz;" +
    "  gl_FragColor = vec4(base + splat, 1.0);" +
    "}";

  // --- advecção -----------------------------------------------------
  // [ARMADILHA 3] dois texel sizes: uTexelVel desloca pela velocidade
  // (grade 256) e uTexelFonte amostra a textura carregada (tinta, 512).
  // Usar um só faz a tinta andar na escala errada.
  var ADVECCAO = CABECA +
    "uniform sampler2D uVelocidade;" +
    "uniform sampler2D uFonte;" +
    "uniform vec2 uTexelVel;" +
    "uniform float uDt;" +
    "uniform float uDissipacao;" +
    "void main() {" +
    "  vec2 coord = vUv - uDt * texture2D(uVelocidade, vUv).xy * uTexelVel;" +
    "  gl_FragColor = uDissipacao * texture2D(uFonte, coord);" +
    "  gl_FragColor.a = 1.0;" +
    "}";

  // --- divergência --------------------------------------------------
  // [ARMADILHA 6] condição de contorno: nas bordas a componente normal
  // é espelhada. Sem isso o fluido "vaza" pelos cantos.
  var DIVERGENCIA = CABECA +
    "uniform sampler2D uVelocidade;" +
    "void main() {" +
    "  float E = texture2D(uVelocidade, vE).x;" +
    "  float D = texture2D(uVelocidade, vD).x;" +
    "  float C = texture2D(uVelocidade, vC).y;" +
    "  float B = texture2D(uVelocidade, vB).y;" +
    "  vec2 centro = texture2D(uVelocidade, vUv).xy;" +
    "  if (vE.x < 0.0)  { E = -centro.x; }" +
    "  if (vD.x > 1.0)  { D = -centro.x; }" +
    "  if (vC.y > 1.0)  { C = -centro.y; }" +
    "  if (vB.y < 0.0)  { B = -centro.y; }" +
    "  gl_FragColor = vec4(0.5 * (D - E + C - B), 0.0, 0.0, 1.0);" +
    "}";

  // --- pressão (uma iteração de Jacobi) -----------------------------
  var PRESSAO = CABECA +
    "uniform sampler2D uPressao;" +
    "uniform sampler2D uDivergencia;" +
    "void main() {" +
    "  float E = texture2D(uPressao, vE).x;" +
    "  float D = texture2D(uPressao, vD).x;" +
    "  float C = texture2D(uPressao, vC).x;" +
    "  float B = texture2D(uPressao, vB).x;" +
    "  float div = texture2D(uDivergencia, vUv).x;" +
    "  gl_FragColor = vec4((E + D + C + B - div) * 0.25, 0.0, 0.0, 1.0);" +
    "}";

  // --- gradiente ----------------------------------------------------
  // [ARMADILHA 5] o fator 0.5 já foi aplicado na divergência. Aplicar de
  // novo aqui removeria só metade da divergência e o fluido continuaria
  // comprimindo.
  var GRADIENTE = CABECA +
    "uniform sampler2D uPressao;" +
    "uniform sampler2D uVelocidade;" +
    "void main() {" +
    "  float E = texture2D(uPressao, vE).x;" +
    "  float D = texture2D(uPressao, vD).x;" +
    "  float C = texture2D(uPressao, vC).x;" +
    "  float B = texture2D(uPressao, vB).x;" +
    "  vec2 v = texture2D(uVelocidade, vUv).xy;" +
    "  v -= vec2(D - E, C - B);" +
    "  gl_FragColor = vec4(v, 0.0, 1.0);" +
    "}";

  // --- REVELAÇÃO: o efeito de assinatura ----------------------------
  // Três linhas fazem tudo: a densidade de tinta vira máscara entre a
  // papel limpo e a chapa impressa. smoothstep e não if, senão a borda
  // entre as duas imagens fica serrilhada e dura.
  // Montado como ARRAY + join("\n") e nao por concatenacao: numa string
  // unica sem quebras, o "//" de um comentario come todo o resto do
  // shader, inclusive o void main(). Foi exatamente o que aconteceu aqui.
  //
  // O QUE ESTE SHADER FAZ: QUADRICROMIA
  // A tinta do fluido nao ilumina a coruja, ela IMPRIME a coruja. E
  // imprime como se fazia nos anos 70: separando a foto em quatro
  // chapas (ciano, magenta, amarelo e preto), cada uma com sua propria
  // reticula num ANGULO diferente. Sao os angulos que produzem a roseta
  // caracteristica da impressao colorida, em vez do padrao de moire que
  // apareceria se todas as chapas usassem o mesmo angulo.
  //
  // Cada chapa entra com um deslocamento proprio: e o erro de registro,
  // o defeito de oficina que faz o olho ler "impresso" e nao "tela".
  //
  // As tintas se acumulam MULTIPLICANDO, porque tinta e subtrativa: cada
  // uma tira luz do papel. Somar daria luz, que e o oposto de imprimir.
  // Três linhas fazem tudo: a densidade de tinta vira máscara entre o
  // fundo verde e o vídeo. Onde a tinta ainda é rala, um halo dourado —
  // é a luz chegando antes da imagem. smoothstep e não if, senão a borda
  // fica serrilhada e dura.
  var REVELACAO = CABECA + [
    "uniform sampler2D uTinta;",
    "uniform sampler2D uImagem;",
    "uniform float uTamanho;",
    "uniform float uSuavidade;",
    "uniform float uLargura;",
    "uniform float uProporcaoImagem;",
    "uniform float uProporcaoTela;",
    "uniform vec2  uResolucao;",
    "uniform float uDpr;",
    "",
    "const vec3 VERDE   = vec3(0.247, 0.357, 0.282);   // #3F5B48, a marca",
    "const vec3 DOURADO = vec3(0.847, 0.639, 0.290);   // #D8A34A, so na peca acesa",
    "",
    "vec2 coverUv(vec2 uv, float aspImg, float aspTela) {",
    "  vec2 razao = vec2(min(aspTela / aspImg, 1.0), min(aspImg / aspTela, 1.0));",
    "  return vec2(uv.x * razao.x + (1.0 - razao.x) * 0.5,",
    "              uv.y * razao.y + (1.0 - razao.y) * 0.5);",
    "}",
    "",
    "void main() {",
    "  vec2 uv = coverUv(vUv, uProporcaoImagem, uProporcaoTela);",
    "  float bruto = texture2D(uTinta, vUv).r * uTamanho;",
    "  float mascara = smoothstep(uSuavidade, uSuavidade + uLargura, bruto);",
    "  vec3 foto = texture2D(uImagem, vec2(uv.x, 1.0 - uv.y)).rgb;",
    "  // o video e escuro de fundo: um leve levantamento para o fio brilhar",
    "  foto = clamp(foto * 1.08 + 0.01, 0.0, 1.0);",
    "  // o halo: presente onde ha tinta mas a imagem ainda nao completou",
    "  float halo = smoothstep(0.0, uSuavidade + uLargura * 0.7, bruto) * (1.0 - mascara);",
    "  vec3 cor = mix(VERDE, foto, mascara) + DOURADO * halo * 0.55;",
    "  gl_FragColor = vec4(cor, 1.0);",
    "}"
  ].join("\n");

  var progCopia      = programa(COPIA);
  var progSplat      = programa(SPLAT);
  var progAdveccao   = programa(ADVECCAO);
  var progDivergencia= programa(DIVERGENCIA);
  var progPressao    = programa(PRESSAO);
  var progGradiente  = programa(GRADIENTE);
  var progRevelacao  = programa(REVELACAO);
  if (!progCopia || !progSplat || !progAdveccao || !progDivergencia ||
      !progPressao || !progGradiente || !progRevelacao) return null;

  // ------------------------------------------------------------------
  // 3. GEOMETRIA: um único quad cobrindo a tela
  // ------------------------------------------------------------------
  var buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  function desenhar(destino) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, destino ? destino.fbo : null);
    gl.viewport(0, 0,
      destino ? destino.largura : gl.drawingBufferWidth,
      destino ? destino.altura  : gl.drawingBufferHeight);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // ------------------------------------------------------------------
  // 4. FRAMEBUFFERS
  // ------------------------------------------------------------------
  function criarFBO(largura, altura) {
    gl.activeTexture(gl.TEXTURE0);
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, formatoMeio.interno, largura, altura, 0,
                  formatoMeio.formato, formatoMeio.tipo, null);

    var fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return null;
    gl.viewport(0, 0, largura, altura);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    return {
      tex: tex, fbo: fbo, largura: largura, altura: altura,
      texel: [1 / largura, 1 / altura],
      ligar: function (unidade) {
        gl.activeTexture(gl.TEXTURE0 + unidade);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        return unidade;
      }
    };
  }

  function criarPar(largura, altura) {
    var a = criarFBO(largura, altura), b = criarFBO(largura, altura);
    if (!a || !b) return null;
    return {
      ler: a, escrever: b,
      trocar: function () { var t = this.ler; this.ler = this.escrever; this.escrever = t; }
    };
  }

  var velocidade = criarPar(CFG.resSim, CFG.resSim);
  var tinta      = criarPar(CFG.resTinta, CFG.resTinta);
  var divergencia= criarFBO(CFG.resSim, CFG.resSim);
  var pressao    = criarPar(CFG.resSim, CFG.resSim);
  if (!velocidade || !tinta || !divergencia || !pressao) return null;

  // ------------------------------------------------------------------
  // 5. TEXTURA DO VÍDEO
  // ------------------------------------------------------------------
  var texVideo = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texVideo);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
                new Uint8Array([63, 91, 72, 255]));      // o verde da capa, ate o video chegar

  var temQuadro = false;

  function atualizarVideo() {
    if (video.readyState < 2 || !video.videoWidth) return;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texVideo);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    temQuadro = true;
  }

  // Assim que um seek termina, o quadro novo já pode subir para a GPU.
  video.addEventListener("seeked", atualizarVideo);
  video.addEventListener("loadeddata", atualizarVideo);

  // ------------------------------------------------------------------
  // 6. PONTEIRO
  // ------------------------------------------------------------------
  var ponteiro = { x: 0.5, y: 0.5, ax: 0.5, ay: 0.5, dx: 0, dy: 0, moveu: false, dentro: false };
  var alvoTempo = 0, tempoSuave = 0;

  function registrar(clienteX, clienteY) {
    var r = tela.getBoundingClientRect();
    var nx = (clienteX - r.left) / r.width;
    var ny = 1.0 - (clienteY - r.top) / r.height;
    ponteiro.dx = (nx - ponteiro.x) * CFG.forcaSplat;
    ponteiro.dy = (ny - ponteiro.y) * CFG.forcaSplat;
    ponteiro.x = nx; ponteiro.y = ny;
    ponteiro.moveu = true;
    ponteiro.dentro = true;
    // A posição horizontal vira o tempo do vídeo: a cabeça acompanha.
    alvoTempo = Math.max(0, Math.min(1, nx));
  }

  window.addEventListener("pointermove", function (e) { registrar(e.clientX, e.clientY); }, { passive: true });
  window.addEventListener("touchmove", function (e) {
    if (e.touches.length) registrar(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });

  // ------------------------------------------------------------------
  // 7. DIMENSIONAMENTO
  // ------------------------------------------------------------------
  function dimensionar() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var l = Math.floor(tela.clientWidth * dpr);
    var a = Math.floor(tela.clientHeight * dpr);
    if (l && a && (tela.width !== l || tela.height !== a)) {
      tela.width = l; tela.height = a;
    }
  }
  dimensionar();
  window.addEventListener("resize", dimensionar);

  // ------------------------------------------------------------------
  // 8. PASSES
  // ------------------------------------------------------------------
  function usar(prog, texel) {
    gl.useProgram(prog.p);
    if (prog.u.uTexel) gl.uniform2f(prog.u.uTexel, texel[0], texel[1]);
  }

  function splat(x, y, dx, dy, corTinta) {
    var proporcao = tela.width / tela.height;

    usar(progSplat, velocidade.ler.texel);
    gl.uniform1i(progSplat.u.uAlvo, velocidade.ler.ligar(0));
    gl.uniform1f(progSplat.u.uProporcao, proporcao);
    gl.uniform2f(progSplat.u.uPonto, x, y);
    gl.uniform3f(progSplat.u.uCor, dx, dy, 0.0);
    gl.uniform1f(progSplat.u.uRaio, CFG.raioSplat);
    desenhar(velocidade.escrever);
    velocidade.trocar();

    usar(progSplat, tinta.ler.texel);
    gl.uniform1i(progSplat.u.uAlvo, tinta.ler.ligar(0));
    gl.uniform1f(progSplat.u.uProporcao, proporcao);
    gl.uniform2f(progSplat.u.uPonto, x, y);
    gl.uniform3f(progSplat.u.uCor, corTinta, corTinta, corTinta);
    gl.uniform1f(progSplat.u.uRaio, CFG.raioSplat);
    desenhar(tinta.escrever);
    tinta.trocar();
  }

  var ultimo = performance.now();
  var vivo = true;
  var quadros = 0;

  // O laço só agenda e mede o tempo. A simulação em si fica separada
  // para poder ser executada fora do requestAnimationFrame — que, entre
  // outras coisas, NÃO dispara em aba de segundo plano.
  function passo(agora) {
    if (!vivo) return;
    requestAnimationFrame(passo);
    if (document.visibilityState !== "visible") { ultimo = agora; return; }

    // [ARMADILHA 1] dt REAL medido por quadro, com teto. Um dt fixo em
    // 1.0 faz o deslocamento da advecção passar de 50 texels por quadro,
    // viola o critério CFL e a simulação morre.
    var dt = Math.min((agora - ultimo) / 1000, 0.0333);
    ultimo = agora;
    if (dt <= 0) return;
    simular(dt);
  }

  function simular(dt) {
    dimensionar();

    // --- o vídeo segue o ponteiro ----------------------------------
    // Aproxima suavemente em vez de saltar, senão o giro fica nervoso.
    tempoSuave += (alvoTempo - tempoSuave) * Math.min(1, dt * 4.5);

    // Um seek por vez. Empilhar seeks (um por quadro) faz o decodificador
    // nunca terminar nenhum: readyState despenca para 1, o quadro nunca
    // chega e a textura congela no marcador. Foi exatamente o que
    // aconteceu aqui. O limiar é a duração de um quadro (1/24 s): abaixo
    // disso o seek não mudaria a imagem e só custaria trabalho.
    if (!video.seeking && isFinite(video.duration) && video.duration > 0) {
      var alvoSeg = tempoSuave * video.duration;
      if (Math.abs(video.currentTime - alvoSeg) > 1 / 24) {
        try { video.currentTime = alvoSeg; } catch (e) { /* ainda não dá */ }
      }
    }
    if (!temQuadro) atualizarVideo();

    // --- injeta o movimento do ponteiro ----------------------------
    if (ponteiro.moveu) {
      ponteiro.moveu = false;
      splat(ponteiro.x, ponteiro.y, ponteiro.dx, ponteiro.dy, 0.42);
    }

    // --- física ------------------------------------------------------
    gl.disable(gl.BLEND);

    // [ARMADILHA 2] a dissipação é POR SEGUNDO. Multiplicar direto faria
    // o visual mudar conforme a taxa de quadros do monitor.
    var dissVel   = Math.pow(CFG.dissipacaoVelocidade, dt * 60);
    var dissTinta = Math.pow(CFG.dissipacaoTinta, dt * 60);

    // advecção da velocidade: o campo se transporta em si mesmo
    usar(progAdveccao, velocidade.ler.texel);
    gl.uniform2f(progAdveccao.u.uTexelVel, velocidade.ler.texel[0], velocidade.ler.texel[1]);
    gl.uniform1i(progAdveccao.u.uVelocidade, velocidade.ler.ligar(0));
    gl.uniform1i(progAdveccao.u.uFonte, velocidade.ler.ligar(0));
    gl.uniform1f(progAdveccao.u.uDt, dt);
    gl.uniform1f(progAdveccao.u.uDissipacao, dissVel);
    desenhar(velocidade.escrever);
    velocidade.trocar();

    // divergência
    usar(progDivergencia, velocidade.ler.texel);
    gl.uniform1i(progDivergencia.u.uVelocidade, velocidade.ler.ligar(0));
    desenhar(divergencia);

    // pressão: Jacobi. 5 iterações deixam o fluido elástico e vazando
    // volume; 60 custam caro sem ganho visível. 20 é o equilíbrio.
    usar(progCopia, pressao.ler.texel);
    gl.uniform1i(progCopia.u.uTex, pressao.ler.ligar(0));
    desenhar(pressao.escrever);
    pressao.trocar();

    usar(progPressao, velocidade.ler.texel);
    gl.uniform1i(progPressao.u.uDivergencia, divergencia.ligar(0));
    for (var i = 0; i < CFG.iteracoesPressao; i++) {
      gl.uniform1i(progPressao.u.uPressao, pressao.ler.ligar(1));
      desenhar(pressao.escrever);
      pressao.trocar();
    }

    // gradiente: subtrai a pressão e o fluido volta a conservar volume
    usar(progGradiente, velocidade.ler.texel);
    gl.uniform1i(progGradiente.u.uPressao, pressao.ler.ligar(0));
    gl.uniform1i(progGradiente.u.uVelocidade, velocidade.ler.ligar(1));
    desenhar(velocidade.escrever);
    velocidade.trocar();

    // advecção da tinta: se este passe some, a tinta não anda e o efeito
    // inteiro morre. Foi o bug nº1 da reprodução original.
    usar(progAdveccao, tinta.ler.texel);
    gl.uniform2f(progAdveccao.u.uTexelVel, velocidade.ler.texel[0], velocidade.ler.texel[1]);
    gl.uniform1i(progAdveccao.u.uVelocidade, velocidade.ler.ligar(0));
    gl.uniform1i(progAdveccao.u.uFonte, tinta.ler.ligar(1));
    gl.uniform1f(progAdveccao.u.uDt, dt);
    gl.uniform1f(progAdveccao.u.uDissipacao, dissTinta);
    desenhar(tinta.escrever);
    tinta.trocar();

    // --- revelação na tela ------------------------------------------
    var aspImg = (video.videoWidth || 16) / (video.videoHeight || 9);
    usar(progRevelacao, [1 / tela.width, 1 / tela.height]);
    gl.uniform1i(progRevelacao.u.uTinta, tinta.ler.ligar(0));
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, texVideo);
    gl.uniform1i(progRevelacao.u.uImagem, 1);
    gl.uniform1f(progRevelacao.u.uTamanho, CFG.tamanhoRevelacao);
    gl.uniform1f(progRevelacao.u.uSuavidade, CFG.suavidadeBorda);
    gl.uniform1f(progRevelacao.u.uLargura, CFG.larguraBorda);
    gl.uniform1f(progRevelacao.u.uProporcaoImagem, aspImg);
    gl.uniform1f(progRevelacao.u.uProporcaoTela, tela.width / tela.height);
    gl.uniform2f(progRevelacao.u.uResolucao, tela.width, tela.height);
    gl.uniform1f(progRevelacao.u.uDpr, Math.min(window.devicePixelRatio || 1, 2));
    desenhar(null);

    quadros++;
  }

  // Um sopro inicial: sem ele a primeira tela é a coruja totalmente
  // em branco e ninguém descobre que há algo para revelar.
  function convite() {
    var t = 0;
    var passos = 34;
    var timer = setInterval(function () {
      if (ponteiro.dentro || t >= passos) { clearInterval(timer); return; }
      var f = t / passos;
      var x = 0.26 + f * 0.52;
      var y = 0.52 + Math.sin(f * 3.14159) * 0.10;
      splat(x, y, (Math.cos(f * 3.0)) * 1100, (Math.sin(f * 2.2)) * 760, 0.40);
      alvoTempo = x;
      t++;
    }, 42);
  }

  // Lê o quadro de volta da GPU. É a ÚNICA prova de que a tinta se move
  // e de que a coruja está sendo amostrada: shader compilando e
  // gl.getError() limpo não provam absolutamente nada.
  function ler() {
    var l = tela.width, a = tela.height;
    var px = new Uint8Array(l * a * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, l, a, gl.RGBA, gl.UNSIGNED_BYTE, px);
    var soma = 0, max = 0, distintos = {}, quentes = 0;
    for (var i = 0; i < px.length; i += 4) {
      var v = px[i] + px[i + 1] + px[i + 2];
      soma += v; if (v > max) max = v;
      if (v > 150) quentes++;
      distintos[v >> 3] = 1;
    }
    return {
      media: +(soma / (l * a)).toFixed(2),
      maximo: max,
      niveis: Object.keys(distintos).length,
      revelado: +(quentes / (l * a) * 100).toFixed(2)
    };
  }

  requestAnimationFrame(function (t) { ultimo = t; passo(t); });
  setTimeout(convite, 700);

  return {
    parar: function () { vivo = false; },
    mover: function (x, y) { registrar(x, y); },
    borrifar: function (x, y, dx, dy) { splat(x, y, dx, dy, 0.34); },
    // Roda N quadros AGORA, sem depender do requestAnimationFrame, e
    // devolve a leitura do último. É assim que se prova que a tinta anda:
    // o readPixels tem de acontecer no mesmo turno do desenho.
    renderizarAgora: function (n, dt) {
      var leitura = null;
      for (var i = 0; i < (n || 1); i++) {
        simular(dt || 0.016);
        leitura = ler();
      }
      return leitura;
    },
    amostrar: ler,
    diagnostico: function () {
      return {
        quadros: quadros, webgl2: webgl2,
        tempoVideo: +video.currentTime.toFixed(2),
        temQuadro: temQuadro, prontoVideo: video.readyState, buscando: video.seeking
      };
    }
  };
};
