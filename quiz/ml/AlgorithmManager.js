// AlgorithmManager.js — minimal manager for question selection + similarity model
// ESM module

export class AlgorithmManager {
  /**
   * @param {import('@supabase/supabase-js').SupabaseClient} supabaseClient
   * @param {object} opts
   * @param {string} [opts.questionTable='question_selection_algorithms']
   * @param {string} [opts.modelTable='ml_model_versions']
   */
  constructor(supabaseClient, opts = {}) {
    this.supabase = supabaseClient;
    this.initialized = false;

    this.TABLES = {
      question: opts.questionTable || 'question_selection_algorithms',
      model:    opts.modelTable    || 'ml_model_versions',
    };

    // In-memory cache of active configs
    this.active = {
      question_selection: null, // row from question_selection_algorithms
      similarity_model:   null, // row from ml_model_versions (model_type = 'similarity_calculator' or 'qdrant')
    };
  }

  /** Initialize once (idempotent) */
  async initialize() {
    if (this.initialized) return;
    await this.loadActiveAlgorithms();
    this.initialized = true;
  }

  /** Load the currently active question selection alg and similarity model */
  async loadActiveAlgorithms() {
    // 1) Question selection algorithm (required)
    const { data: qRows, error: qErr } = await this.supabase
      .from(this.TABLES.question)
      .select('*')
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (qErr) throw new Error(`Failed to load question selection algorithms: ${qErr.message}`);
    if (!qRows?.length) {
      throw new Error('No active question selection algorithm found');
    }
    this.active.question_selection = qRows[0];

    // 2) Similarity model (optional; used for course matching downstream)
    const { data: mRows, error: mErr } = await this.supabase
      .from(this.TABLES.model)
      .select('*')
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (mErr) {
      // Non-fatal: you can still run the quiz w/out similarity model
      console.warn('Could not load similarity model:', mErr.message);
    }

    // Prefer an explicit 'similarity_calculator' model_type if present
    let sim = null;
    if (Array.isArray(mRows) && mRows.length) {
      sim = mRows.find(r => r.model_type === 'similarity_calculator') || mRows[0];
    }
    this.active.similarity_model = sim;

    // Tiny log for sanity
    console.log('[AlgorithmManager] active', {
      question_selection: this.active.question_selection?.version || 'n/a',
      similarity_model:   this.active.similarity_model?.version   || 'none'
    });
  }

  /**
   * Return the active algorithm config for a given type.
   * @param {'question_selection'|'similarity_model'} type
   */
  async getAlgorithmForUser(type /*, sessionId, userFingerprint */) {
    if (!this.initialized) await this.initialize();

    if (type === 'question_selection') {
      if (!this.active.question_selection) {
        throw new Error('Question selection algorithm not loaded');
      }
      return this.active.question_selection;
    }

    if (type === 'similarity_model') {
      // Optional: downstream can handle a null model by calling a default path
      return this.active.similarity_model;
    }

    throw new Error(`Unknown algorithm type: ${type}`);
  }

  /**
   * Fetch a specific version of an algorithm (useful for pinning/debug).
   * @param {'question_selection'|'similarity_model'} type
   * @param {string} version
   */
  async getAlgorithmByVersion(type, version) {
    const table =
      type === 'question_selection' ? this.TABLES.question
    : type === 'similarity_model'   ? this.TABLES.model
    : null;

    if (!table) throw new Error(`Unknown algorithm type: ${type}`);

    const { data, error } = await this.supabase
      .from(table)
      .select('*')
      .eq('version', version)
      .single();

    if (error) throw new Error(`Failed to load ${type} v${version}: ${error.message}`);
    return data;
  }

  /**
   * Activate a specific version and reload cache.
   * @param {'question_selection'|'similarity_model'} type
   * @param {string} version
   */
  async activateAlgorithm(type, version) {
    const table =
      type === 'question_selection' ? this.TABLES.question
    : type === 'similarity_model'   ? this.TABLES.model
    : null;

    if (!table) throw new Error(`Unknown algorithm type: ${type}`);

    // Deactivate all
    const { error: dErr } = await this.supabase
      .from(table)
      .update({ is_active: false })
      .neq('version', '');

    if (dErr) throw new Error(`Failed to deactivate ${type}: ${dErr.message}`);

    // Activate requested version
    const { error: aErr } = await this.supabase
      .from(table)
      .update({ is_active: true })
      .eq('version', version);

    if (aErr) throw new Error(`Failed to activate ${type} v${version}: ${aErr.message}`);

    // Refresh cache
    await this.loadActiveAlgorithms();
    return true;
  }

  /** Small summary object for diagnostics */
  getActiveAlgorithmsSummary() {
    return {
      question_selection: this.active.question_selection
        ? {
            version: this.active.question_selection.version,
            name:    this.active.question_selection.algorithm_name || 'question_selection',
            isActive:true
          }
        : null,
      similarity_model: this.active.similarity_model
        ? {
            version: this.active.similarity_model.version,
            name:    this.active.similarity_model.model_type || 'similarity',
            isActive:true
          }
        : null
    };
  }

  /** True if we’ve loaded configs successfully */
  isConfigured() {
    return !!this.active.question_selection; // similarity model is optional
  }
}
